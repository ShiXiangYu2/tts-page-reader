/**
 * Background Service Worker - 简化为仅处理存储和特殊消息
 * 悬浮工具条模式下，大部分功能在 content.js 中直接处理
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 存储相关操作（虽然现在主要在 content.js 中直接使用 chrome.storage）
  if (message.action === 'saveSettings') {
    chrome.storage.local.set(message.settings, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === 'loadSettings') {
    chrome.storage.local.get({
      rate: 1.0,
      pitch: 1.0,
      voiceName: ''
    }, (settings) => {
      sendResponse(settings);
    });
    return true;
  }

  return false;
});
