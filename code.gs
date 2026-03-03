/**
 * UI表示
 */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
      .evaluate()
      .setTitle('Discord Reminder Pro')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 初期セットアップ（全シートの作成）
 */
function setupSystem() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = {
    'channels': ['サーバー名', 'チャンネル名', 'Webhook URL'],
    'reminders': ['ステータス', 'メッセージ内容', 'チャンネル名', '次回実行予定日時', 'スケジュール種類', '作成日', 'Webhook URL', '最終実行日時', '曜日データ'],
    'templates': ['テンプレート名', 'メッセージ内容', 'スケジュール種類', '曜日データ']
  };

  Object.keys(sheets).forEach(name => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(sheets[name]);
    }
    sheet.getRange("1:1").setFontWeight("bold");
    sheet.setFrozenRows(1);
  });
  return "セットアップが完了しました。";
}

/**
 * Webhook（チャンネル）管理
 */
function getChannels() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('channels');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  data.shift();
  return data.map((row, i) => ({
    rowIndex: i + 2,
    label: (row[0] || row[1]) ? `${row[0]} > ${row[1]}` : row[2].substring(0, 25),
    url: row[2]
  }));
}

function saveChannel(data) {
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName('channels').appendRow([data.serverName, data.channelName, data.webhookUrl]);
  return "Webhookを登録しました";
}

function deleteChannel(index) {
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName('channels').deleteRow(index);
  return "Webhookを削除しました";
}

/**
 * リマインダー管理
 */
function getReminders() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('reminders');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const header = data.shift();
  const col = {}; header.forEach((h, i) => col[h] = i);

  return data.map((row, i) => ({
    rowIndex: i + 2,
    status: row[col['ステータス']],
    content: row[col['メッセージ内容']],
    channel: row[col['チャンネル名']],
    nextRun: row[col['次回実行予定日時']] ? Utilities.formatDate(new Date(row[col['次回実行予定日時']]), "JST", "yyyy/MM/dd HH:mm") : "-",
    type: row[col['スケジュール種類']],
    webhookUrl: row[col['Webhook URL']],
    days: JSON.parse(row[col['曜日データ']] || "[]")
  })).reverse();
}

function saveReminder(formData) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('reminders');
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  let nextRun = new Date(formData.datetime);
  if (formData.type === 'weekly' && formData.days.length > 0) {
    nextRun = getNextRunDate(new Date(), formData.days, Utilities.formatDate(nextRun, "JST", "HH:mm"));
  }

  const rowData = header.map(h => {
    switch(h) {
      case 'ステータス': return formData.status || 'active';
      case 'メッセージ内容': return formData.message;
      case 'チャンネル名': return formData.channelName;
      case '次回実行予定日時': return nextRun;
      case 'スケジュール種類': return formData.type;
      case '作成日': return new Date();
      case 'Webhook URL': return formData.webhookUrl;
      case '曜日データ': return JSON.stringify(formData.days);
      default: return "";
    }
  });

  if (formData.editRowIndex) {
    sheet.getRange(formData.editRowIndex, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
  return { success: true };
}

function deleteReminder(index) {
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName('reminders').deleteRow(index);
  return "削除しました";
}

function toggleStatus(index, current) {
  const newStatus = (current === 'active') ? 'disabled' : 'active';
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName('reminders').getRange(index, 1).setValue(newStatus);
  return newStatus;
}

/**
 * テンプレート管理
 */
function getTemplates() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('templates');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  data.shift();
  return data.map((row, i) => ({
    rowIndex: i + 2,
    name: row[0],
    content: row[1],
    type: row[2],
    days: JSON.parse(row[3] || "[]")
  }));
}

function saveTemplate(data) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('templates');
  sheet.appendRow([data.name, data.content, data.type, JSON.stringify(data.days)]);
  return "テンプレートとして保存しました";
}

function deleteTemplate(index) {
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName('templates').deleteRow(index);
  return "テンプレートを削除しました";
}

/**
 * 実行エンジン (1分毎トリガー)
 */
function executeReminders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('reminders');
  if (!sheet || sheet.getLastRow() < 2) return;

  const data = sheet.getDataRange().getValues();
  const header = data.shift();
  const col = {}; header.forEach((h, i) => col[h] = i);
  const now = new Date();

  data.forEach((row, i) => {
    const rowIndex = i + 2;
    if (row[col['ステータス']] === 'active' && row[col['次回実行予定日時']] <= now) {
      try {
        UrlFetchApp.fetch(row[col['Webhook URL']], {
          method: "post", contentType: "application/json",
          payload: JSON.stringify({ content: row[col['メッセージ内容']] })
        });

        let nextStatus = 'active';
        let newNextRun = new Date(row[col['次回実行予定日時']]);
        const type = row[col['スケジュール種類']];

        if (type === 'once') {
          nextStatus = 'completed';
        } else if (type === 'weekly') {
          const days = JSON.parse(row[col['曜日データ']] || "[]");
          newNextRun = getNextRunDate(new Date(), days, Utilities.formatDate(newNextRun, "JST", "HH:mm"));
        } else if (type === 'monthly') {
          newNextRun.setMonth(newNextRun.getMonth() + 1);
        }

        sheet.getRange(rowIndex, col['ステータス']+1).setValue(nextStatus);
        sheet.getRange(rowIndex, col['次回実行予定日時']+1).setValue(newNextRun);
        sheet.getRange(rowIndex, col['最終実行日時']+1).setValue(new Date());
      } catch (e) {
        sheet.getRange(rowIndex, col['ステータス']+1).setValue('error');
      }
    }
  });
}

function getNextRunDate(baseDate, targetDays, timeStr) {
  let nextDate = new Date(baseDate);
  const [hrs, mins] = timeStr.split(':').map(Number);
  nextDate.setHours(hrs, mins, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (i > 0) nextDate.setDate(nextDate.getDate() + 1);
    if (targetDays.includes(nextDate.getDay()) && nextDate > new Date()) return nextDate;
  }
  return nextDate;
}
