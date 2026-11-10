'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const SUBSCRIPTIONS = new Set(['fish:state', 'fish:chat', 'fish:pet']);

function subscribe(channel, callback) {
  if (!SUBSCRIPTIONS.has(channel)) throw new TypeError('不允许订阅此消息通道');
  if (typeof callback !== 'function') throw new TypeError('订阅回调必须是函数');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('fish', Object.freeze({
  action(method, payload) {
    if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(method)) {
      return Promise.reject(new TypeError('无效的操作名称'));
    }
    return ipcRenderer.invoke('fish:action', method, payload === undefined ? null : payload);
  },
  onState(callback) { return subscribe('fish:state', callback); },
  onChat(callback) { return subscribe('fish:chat', callback); },
  onPet(callback) { return subscribe('fish:pet', callback); },
}));
