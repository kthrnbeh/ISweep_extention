// ISweep background entry point.
// Loads the existing background worker, then reconnects already-open ISweep site tabs
// so extension reloads do not leave preference sync stuck on an old/empty cache.
importScripts('background.js');

(function initExistingSiteBridgeRecovery() {
  'use strict';

  const ISWEEP_SITE_MATCHERS = [
    /^https:\/\/kthrnbeh\.github\.io\/ISweep\//i,
    /^http:\/\/127\.0\.0\.1:5500\/(?:ISweep_frontend\/docs|docs)\//i,
    /^http:\/\/localhost:5500\/(?:ISweep_frontend\/docs|docs)\//i,
  ];

  function isIsweepSiteUrl(url) {
    const value = String(url || '');
    return ISWEEP_SITE_MATCHERS.some((matcher) => matcher.test(value));
  }

  async function reconnectOpenIsweepTabs(reason = 'worker_started') {
    if (!chrome.tabs?.query || !chrome.scripting?.executeScript) return;

    try {
      const tabs = await chrome.tabs.query({});
      const matchingTabs = tabs.filter((tab) => tab?.id && isIsweepSiteUrl(tab.url));

      if (!matchingTabs.length) {
        console.log('[ISWEEP][SYNC_BOOT] no open ISweep site tabs to reconnect', { reason });
        return;
      }

      for (const tab of matchingTabs) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['site_token_bridge.js'],
          });
          console.log('[ISWEEP][SYNC_BOOT] preference bridge attached', {
            reason,
            tabId: tab.id,
            url: tab.url,
          });
        } catch (error) {
          console.warn('[ISWEEP][SYNC_BOOT] preference bridge attach failed', {
            reason,
            tabId: tab.id,
            error: error?.message || String(error),
          });
        }
      }
    } catch (error) {
      console.warn('[ISWEEP][SYNC_BOOT] open-tab preference recovery failed', {
        reason,
        error: error?.message || String(error),
      });
    }
  }

  // Run every time the service worker starts/restarts, including extension reloads.
  setTimeout(() => reconnectOpenIsweepTabs('worker_started'), 250);

  if (chrome.runtime?.onInstalled?.addListener) {
    chrome.runtime.onInstalled.addListener(() => {
      setTimeout(() => reconnectOpenIsweepTabs('extension_installed_or_updated'), 250);
    });
  }

  if (chrome.runtime?.onStartup?.addListener) {
    chrome.runtime.onStartup.addListener(() => {
      setTimeout(() => reconnectOpenIsweepTabs('browser_started'), 250);
    });
  }
})();
