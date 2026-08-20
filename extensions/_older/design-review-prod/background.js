/**
 * Toggles review mode in the active tab when the toolbar icon is clicked.
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_REVIEW_MODE' });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['config.js', 'content.js'],
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_REVIEW_MODE' });
    } catch {
      // Restricted page (e.g. chrome://) — ignore
    }
  }
});
