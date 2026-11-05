const APP_URL = 'https://iangor.github.io/Listik/';
function isAppURL(value, site = APP_URL) {
  try {
    const url = new URL(value);
    const base = new URL(site);
    return !url.username && !url.password && url.origin === base.origin && (url.pathname === base.pathname || url.pathname.startsWith(base.pathname.endsWith('/') ? base.pathname : base.pathname + '/'));
  } catch { return false; }
}
function isExternalURL(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && ['https:', 'http:', 'mailto:'].includes(url.protocol);
  } catch { return false; }
}
function isTrustedSender(event, contents, site = APP_URL) {
  return event.sender === contents && event.senderFrame === contents.mainFrame && isAppURL(event.senderFrame?.url, site);
}
module.exports = { APP_URL, isAppURL, isExternalURL, isTrustedSender };
