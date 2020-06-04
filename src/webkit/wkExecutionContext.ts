/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { WKSession, isSwappedOutError } from './wkConnection';
import { Protocol } from './protocol';
import * as js from '../javascript';
import * as debugSupport from '../debug/debugSupport';
import { parseEvaluationResultValue } from '../utilityScriptSerializers';

export class WKExecutionContext implements js.ExecutionContextDelegate {
  private readonly _session: WKSession;
  readonly _contextId: number | undefined;
  private _contextDestroyedCallback: () => void = () => {};
  private readonly _executionContextDestroyedPromise: Promise<unknown>;

  constructor(session: WKSession, contextId: number | undefined) {
    this._session = session;
    this._contextId = contextId;
    this._executionContextDestroyedPromise = new Promise((resolve, reject) => {
      this._contextDestroyedCallback = resolve;
    });
  }

  _dispose() {
    this._contextDestroyedCallback();
  }

  async rawEvaluate(expression: string): Promise<string> {
    try {
      const response = await this._session.send('Runtime.evaluate', {
        expression: debugSupport.ensureSourceUrl(expression),
        contextId: this._contextId,
        returnByValue: false
      });
      if (response.wasThrown)
        throw new Error('Evaluation failed: ' + response.result.description);
      return response.result.objectId!;
    } catch (error) {
      throw rewriteError(error);
    }
  }

  async evaluateWithArguments(expression: string, returnByValue: boolean, utilityScript: js.JSHandle<any>, values: any[], objectIds: string[]): Promise<any> {
    try {
      let response = await this._session.send('Runtime.callFunctionOn', {
        functionDeclaration: expression,
        objectId: utilityScript._objectId!,
        arguments: [
          { objectId: utilityScript._objectId },
          ...values.map(value => ({ value })),
          ...objectIds.map(objectId => ({ objectId })),
        ],
        returnByValue: false, // We need to return real Promise if that is a promise.
        emulateUserGesture: true
      });
      if (response.result.objectId && response.result.className === 'Promise') {
        response = await Promise.race([
          this._executionContextDestroyedPromise.then(() => contextDestroyedResult),
          this._session.send('Runtime.awaitPromise', {
            promiseObjectId: response.result.objectId,
            returnByValue: false
          })
        ]);
      }
      if (response.wasThrown)
        throw new Error('Evaluation failed: ' + response.result.description);
      if (!returnByValue)
        return utilityScript._context.createHandle(response.result);
      if (response.result.objectId)
        return await this._returnObjectByValue(utilityScript._context, response.result.objectId);
      return parseEvaluationResultValue(response.result.value);
    } catch (error) {
      throw rewriteError(error);
    }
  }

  private async _returnObjectByValue(context: js.ExecutionContext, objectId: Protocol.Runtime.RemoteObjectId): Promise<any> {
    // This is different from handleJSONValue in that it does not throw.
    try {
      const utilityScript = await context.utilityScript();
      const serializeResponse = await this._session.send('Runtime.callFunctionOn', {
        functionDeclaration: 'object => object' + debugSupport.generateSourceUrl(),
        objectId: utilityScript._objectId!,
        arguments: [ { objectId } ],
        returnByValue: true
      });
      if (serializeResponse.wasThrown)
        return undefined;
      return parseEvaluationResultValue(serializeResponse.result.value);
    } catch (error) {
      return undefined;
      // TODO: we should actually throw an error, but that breaks the common case of undefined
      // that is for some reason reported as an object and cannot be accessed after navigation.
      // throw rewriteError(error);
    }
  }

  async getProperties(handle: js.JSHandle): Promise<Map<string, js.JSHandle>> {
    const objectId = handle._objectId;
    if (!objectId)
      return new Map();
    const response = await this._session.send('Runtime.getProperties', {
      objectId,
      ownProperties: true
    });
    const result = new Map();
    for (const property of response.properties) {
      if (!property.enumerable || !property.value)
        continue;
      result.set(property.name, handle._context.createHandle(property.value));
    }
    return result;
  }

  createHandle(context: js.ExecutionContext, remoteObject: Protocol.Runtime.RemoteObject): js.JSHandle {
    const isPromise = remoteObject.className === 'Promise';
    return new js.JSHandle(context, isPromise ? 'promise' : remoteObject.subtype || remoteObject.type, remoteObject.objectId, potentiallyUnserializableValue(remoteObject));
  }

  async releaseHandle(handle: js.JSHandle): Promise<void> {
    if (!handle._objectId)
      return;
    await this._session.send('Runtime.releaseObject', {objectId: handle._objectId}).catch(error => {});
  }
}

const contextDestroyedResult = {
  wasThrown: true,
  result: {
    description: 'Protocol error: Execution context was destroyed, most likely because of a navigation.'
  } as Protocol.Runtime.RemoteObject
};

function potentiallyUnserializableValue(remoteObject: Protocol.Runtime.RemoteObject): any {
  const value = remoteObject.value;
  const unserializableValue = remoteObject.type === 'number' && value === null ? remoteObject.description : undefined;
  return unserializableValue ? js.parseUnserializableValue(unserializableValue) : value;
}

function rewriteError(error: Error): Error {
  if (isSwappedOutError(error) || error.message.includes('Missing injected script for given'))
    return new Error('Execution context was destroyed, most likely because of a navigation.');
  return error;
}
