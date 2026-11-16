/**
 * Cinema suggestions: loader.
 * The real code lives in GitHub (Nyraxy/cinema-data, apps-script/Code.gs) and is loaded fresh on
 * every run, so updates pushed to the repo go live without touching this project.
 *
 *   install()  run once: creates the daily trigger (05:00–06:00).
 *   testRun()  sends a [TEST] email now.
 */
const CODE_URL = 'https://raw.githubusercontent.com/Nyraxy/cinema-data/main/apps-script/Code.gs';

function load_() {
  const code = UrlFetchApp.fetch(CODE_URL + '?t=' + Date.now()).getContentText('UTF-8');
  (0, eval)(code);
}

function run() { load_(); main(false); }
function testRun() { load_(); main(true); }
function install() { load_(); setup(); }

// Never called. Lists the Google services the loaded code uses, so Apps Script asks permission for them.
function permissions_() {
  MailApp.sendEmail; GmailApp.search; CalendarApp.getDefaultCalendar; UrlFetchApp.fetch;
  PropertiesService.getScriptProperties; ScriptApp.newTrigger; Session.getEffectiveUser;
}
