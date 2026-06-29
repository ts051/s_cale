(function () {
  const STORE_KEY = 'whiteTree:static:v1';
  const SESSION_KEY = 'whiteTree:static:session';
  const COLORS = ['#1aa260', '#e67c73', '#f4511e', '#1a73e8', '#8e24aa', '#f6bf26', '#039be5', '#33b679', '#0b8043', '#3f51b5'];

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register = function () {
      return Promise.resolve({ scope: location.href });
    };
  }

  function readStore() {
    const fallback = { users: [], labels: [], events: [], nextUserId: 1, nextLabelId: 1, nextEventId: 1 };
    try {
      return Object.assign(fallback, JSON.parse(localStorage.getItem(STORE_KEY) || '{}'));
    } catch (error) {
      return fallback;
    }
  }

  function writeStore(store) {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }

  function currentUser(store) {
    const userId = Number(localStorage.getItem(SESSION_KEY));
    return store.users.find(user => user.id === userId) || null;
  }

  function jsonResponse(data, status) {
    return Promise.resolve(new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  function normalizePath(input) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    return `${url.pathname}${url.search}`.replace(/^\/[^/]+\/api\//, '/api/');
  }

  function ensureLabels(store, userId) {
    const hasShared = store.labels.some(label => label.is_shared);
    if (!hasShared) {
      for (let i = 1; i <= 10; i += 1) {
        store.labels.push({
          id: store.nextLabelId++,
          user_id: 0,
          name: `ラベル${i}`,
          color: COLORS[i - 1],
          is_shared: true,
          sort_order: i
        });
      }
    }

    const hasPrivate = store.labels.some(label => !label.is_shared && label.user_id === userId);
    if (!hasPrivate) {
      for (let i = 1; i <= 10; i += 1) {
        store.labels.push({
          id: store.nextLabelId++,
          user_id: userId,
          name: `ラベル${i}`,
          color: COLORS[i - 1],
          is_shared: false,
          sort_order: i
        });
      }
    }
  }

  function eventForCalendar(row, userId, labels) {
    const label = labels.find(item => Number(item.id) === Number(row.label_id));
    const color = label?.color || (row.is_shared ? '#1aa260' : '#1a73e8');
    return {
      id: row.id,
      title: row.title,
      start: row.start,
      end: row.end,
      allDay: !!row.allDay,
      backgroundColor: color,
      borderColor: color,
      textColor: '#ffffff',
      color,
      extendedProps: {
        original_id: row.id,
        is_shared: !!row.is_shared,
        is_mine: row.user_id === userId,
        label_id: row.label_id || null,
        label_order: label?.sort_order || 999,
        recurrence: row.recurrence || null,
        memo: row.memo || '',
        is_holiday: 0
      }
    };
  }

  function parseDateTime(value) {
    if (!value) return null;
    const [datePart, timePart] = value.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    if (!year || !month || !day) return null;
    if (!timePart) return new Date(year, month - 1, day);
    const [hour, minute, second] = timePart.split(':').map(Number);
    return new Date(year, month - 1, day, hour || 0, minute || 0, second || 0);
  }

  function formatDateTime(date, hasTime) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    if (!hasTime) return `${y}-${m}-${d}`;
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  }

  function addRecurrenceDate(date, recurrence) {
    const next = new Date(date.getTime());
    if (recurrence === 'weekly') next.setDate(next.getDate() + 7);
    if (recurrence === 'monthly') next.setMonth(next.getMonth() + 1);
    if (recurrence === 'yearly') next.setFullYear(next.getFullYear() + 1);
    return next;
  }

  function calendarEvents(store, user, searchParams) {
    const startLimit = parseDateTime(searchParams.get('start')) || new Date(new Date().getFullYear() - 1, 0, 1);
    const endLimit = parseDateTime(searchParams.get('end')) || new Date(new Date().getFullYear() + 1, 11, 31);
    const visible = store.events.filter(event => event.is_shared || event.user_id === user.id);
    const output = [];

    visible.forEach(row => {
      const base = eventForCalendar(row, user.id, store.labels);
      if (!row.recurrence) {
        output.push(base);
        return;
      }

      const start = parseDateTime(row.start);
      const end = parseDateTime(row.end);
      if (!start || !end) {
        output.push(base);
        return;
      }

      const duration = end.getTime() - start.getTime();
      const hasTime = row.start.includes('T');
      let current = new Date(start.getTime());
      let guard = 0;
      while (current <= endLimit && guard < 1000) {
        if (current >= startLimit) {
          const occurrence = JSON.parse(JSON.stringify(base));
          occurrence.id = `${row.id}_${formatDateTime(current, false).replaceAll('-', '')}`;
          occurrence.start = formatDateTime(current, hasTime);
          occurrence.end = formatDateTime(new Date(current.getTime() + duration), hasTime);
          output.push(occurrence);
        }
        current = addRecurrenceDate(current, row.recurrence);
        guard += 1;
      }
    });

    return output;
  }

  function escapeIcs(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  function unescapeIcs(value) {
    return String(value || '')
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  function toIcsDate(value, allDay) {
    if (!value) return '';
    if (allDay) return value.split('T')[0].replaceAll('-', '');
    return value.replaceAll('-', '').replaceAll(':', '').replace('T', 'T');
  }

  function parseIcsDate(value) {
    const raw = String(value || '').trim();
    if (/^\d{8}$/.test(raw)) {
      return { value: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, allDay: true };
    }
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
    if (!match) return { value: '', allDay: false };
    return { value: `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`, allDay: false };
  }

  function foldIcsLine(line) {
    const chunks = [];
    let rest = line;
    while (rest.length > 74) {
      chunks.push(rest.slice(0, 74));
      rest = ` ${rest.slice(74)}`;
    }
    chunks.push(rest);
    return chunks.join('\r\n');
  }

  window.exportICSFile = function () {
    const store = readStore();
    const user = currentUser(store);
    if (!user) {
      alert('ログインしてください。');
      return;
    }

    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WhiteTree//Static Calendar//JA', 'CALSCALE:GREGORIAN'];
    store.events.filter(event => event.is_shared || event.user_id === user.id).forEach(event => {
      const label = store.labels.find(item => Number(item.id) === Number(event.label_id));
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:whitetree-${event.id}@local`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(event.allDay ? `DTSTART;VALUE=DATE:${toIcsDate(event.start, true)}` : `DTSTART:${toIcsDate(event.start, false)}`);
      lines.push(event.allDay ? `DTEND;VALUE=DATE:${toIcsDate(event.end, true)}` : `DTEND:${toIcsDate(event.end, false)}`);
      lines.push(foldIcsLine(`SUMMARY:${escapeIcs(event.title)}`));
      if (label) lines.push(foldIcsLine(`CATEGORIES:${escapeIcs(label.name)}`));
      if (event.memo) lines.push(foldIcsLine(`DESCRIPTION:${escapeIcs(event.memo)}`));
      if (event.recurrence) lines.push(`RRULE:FREQ=${event.recurrence.toUpperCase() === 'WEEKLY' ? 'WEEKLY' : event.recurrence.toUpperCase() === 'MONTHLY' ? 'MONTHLY' : 'YEARLY'}`);
      lines.push(`X-WHITETREE-SCOPE:${event.is_shared ? 'SHARED' : 'PRIVATE'}`);
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');

    const blob = new Blob([`${lines.join('\r\n')}\r\n`], { type: 'text/calendar;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'whitetree-events.ics';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  window.importICSFile = function () {
    const input = document.getElementById('icsFileInput');
    if (!input || input.files.length === 0) {
      alert('ICSファイルを選択してください');
      return;
    }

    const store = readStore();
    const user = currentUser(store);
    if (!user) {
      alert('ログインしてください。');
      return;
    }

    input.files[0].text().then(text => {
      const unfolded = text.replace(/\r?\n[ \t]/g, '');
      const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
      let count = 0;
      blocks.forEach(block => {
        const fields = {};
        block.split(/\r?\n/).forEach(line => {
          const index = line.indexOf(':');
          if (index < 0) return;
          const key = line.slice(0, index).split(';')[0].toUpperCase();
          fields[key] = line.slice(index + 1);
        });

        const start = parseIcsDate(fields.DTSTART);
        const end = parseIcsDate(fields.DTEND);
        if (!start.value || !fields.SUMMARY) return;

        const isShared = (fields['X-WHITETREE-SCOPE'] || '').toUpperCase() !== 'PRIVATE';
        const category = unescapeIcs(fields.CATEGORIES || '');
        const label = category
          ? store.labels.find(item => item.name === category && (isShared ? item.is_shared : (!item.is_shared && item.user_id === user.id)))
          : null;
        const rrule = String(fields.RRULE || '').toUpperCase();
        let recurrence = '';
        if (rrule.includes('FREQ=WEEKLY')) recurrence = 'weekly';
        if (rrule.includes('FREQ=MONTHLY')) recurrence = 'monthly';
        if (rrule.includes('FREQ=YEARLY')) recurrence = 'yearly';

        store.events.push({
          id: store.nextEventId++,
          user_id: user.id,
          title: unescapeIcs(fields.SUMMARY),
          start: start.value,
          end: end.value || start.value,
          allDay: start.allDay,
          is_shared: isShared,
          label_id: label?.id || null,
          recurrence,
          memo: unescapeIcs(fields.DESCRIPTION || '')
        });
        count += 1;
      });
      writeStore(store);
      input.value = '';
      alert(`${count} 件の予定をインポートしました。`);
      if (typeof toggleDrawer === 'function') toggleDrawer(false);
      if (typeof refreshEvents === 'function') refreshEvents();
    }).catch(error => {
      console.error(error);
      alert('インポートに失敗しました。');
    });
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const pathWithSearch = normalizePath(input);
    if (!pathWithSearch.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    const url = new URL(pathWithSearch, location.href);
    const path = url.pathname;
    const method = ((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    const store = readStore();
    const user = currentUser(store);

    function requireUser() {
      if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
      ensureLabels(store, user.id);
      return null;
    }

    async function bodyJson() {
      if (init?.body) return JSON.parse(init.body);
      if (typeof input !== 'string' && input.body) return JSON.parse(await input.text());
      return {};
    }

    if (path === '/api/me' && method === 'GET') {
      if (!user) return jsonResponse({ logged_in: false });
      ensureLabels(store, user.id);
      writeStore(store);
      return jsonResponse({ logged_in: true, user_id: user.id, username: user.username, week_start: user.week_start ?? 1 });
    }

    if (path === '/api/login' && method === 'POST') {
      return bodyJson().then(data => {
        const username = String(data.username || 'user').trim() || 'user';
        let nextUser = store.users.find(item => item.username === username);
        if (!nextUser) {
          nextUser = { id: store.nextUserId++, username, week_start: 1 };
          store.users.push(nextUser);
        }
        localStorage.setItem(SESSION_KEY, String(nextUser.id));
        ensureLabels(store, nextUser.id);
        writeStore(store);
        return jsonResponse({ success: true, user_id: nextUser.id, username: nextUser.username, week_start: nextUser.week_start });
      });
    }

    if (path === '/api/logout' && method === 'POST') {
      localStorage.removeItem(SESSION_KEY);
      return jsonResponse({ success: true });
    }

    const authError = requireUser();
    if (authError) return authError;

    if (path === '/api/settings' && method === 'PUT') {
      return bodyJson().then(data => {
        user.username = String(data.username || user.username).trim() || user.username;
        writeStore(store);
        return jsonResponse({ success: true });
      });
    }

    if (path === '/api/preferences' && method === 'PUT') {
      return bodyJson().then(data => {
        user.week_start = Number(data.week_start) === 0 ? 0 : 1;
        writeStore(store);
        return jsonResponse({ success: true, week_start: user.week_start });
      });
    }

    if (path === '/api/labels' && method === 'GET') {
      const labels = store.labels
        .filter(label => label.is_shared || label.user_id === user.id)
        .sort((a, b) => Number(b.is_shared) - Number(a.is_shared) || (a.sort_order || 999) - (b.sort_order || 999));
      writeStore(store);
      return jsonResponse(labels);
    }

    if (path === '/api/labels' && method === 'POST') {
      return jsonResponse({ success: false, error: '最大10個の固定ラベル枠仕様のため、新規作成はできません。既存のラベルを編集してください。' });
    }

    if (path === '/api/labels/reorder' && method === 'PUT') {
      return bodyJson().then(data => {
        (data.label_ids || []).forEach((id, index) => {
          const label = store.labels.find(item => Number(item.id) === Number(id));
          if (label) label.sort_order = index + 1;
        });
        writeStore(store);
        return jsonResponse({ success: true });
      });
    }

    const labelMatch = path.match(/^\/api\/labels\/(\d+)$/);
    if (labelMatch && method === 'PUT') {
      return bodyJson().then(data => {
        const label = store.labels.find(item => Number(item.id) === Number(labelMatch[1]));
        if (!label) return jsonResponse({ error: 'Not found' }, 404);
        label.name = String(data.name || label.name);
        label.color = String(data.color || label.color);
        writeStore(store);
        return jsonResponse({ success: true });
      });
    }
    if (labelMatch && method === 'DELETE') {
      const label = store.labels.find(item => Number(item.id) === Number(labelMatch[1]));
      if (!label) return jsonResponse({ error: 'Not found' }, 404);
      const siblings = store.labels.filter(item => item.is_shared === label.is_shared && (label.is_shared || item.user_id === user.id))
        .sort((a, b) => (a.sort_order || 999) - (b.sort_order || 999));
      const index = Math.max(0, siblings.findIndex(item => item.id === label.id));
      label.name = `ラベル${index + 1}`;
      label.color = COLORS[index % COLORS.length];
      writeStore(store);
      return jsonResponse({ success: true });
    }

    if (path === '/api/holidays' && method === 'GET') {
      return jsonResponse([]);
    }

    if (path === '/api/events' && method === 'GET') {
      return jsonResponse(calendarEvents(store, user, url.searchParams));
    }

    if (path === '/api/events' && method === 'POST') {
      return bodyJson().then(data => {
        const id = store.nextEventId++;
        store.events.push({
          id,
          user_id: user.id,
          title: data.title,
          start: data.start,
          end: data.end,
          allDay: !!(data.allDay || data.is_all_day),
          is_shared: !!data.is_shared,
          label_id: data.label_id ? Number(data.label_id) : null,
          recurrence: data.recurrence || '',
          memo: data.memo || ''
        });
        writeStore(store);
        return jsonResponse({ success: true, id });
      });
    }

    if (path === '/api/events/clear' && method === 'DELETE') {
      store.events = store.events.filter(event => !event.is_shared && event.user_id !== user.id);
      writeStore(store);
      return jsonResponse({ success: true });
    }

    const eventMatch = path.match(/^\/api\/events\/(\d+)$/);
    if (eventMatch && method === 'PUT') {
      return bodyJson().then(data => {
        const event = store.events.find(item => Number(item.id) === Number(eventMatch[1]));
        if (!event) return jsonResponse({ error: 'Not found' }, 404);
        Object.assign(event, {
          title: data.title,
          start: data.start,
          end: data.end,
          allDay: !!(data.allDay || data.is_all_day),
          is_shared: !!data.is_shared,
          label_id: data.label_id ? Number(data.label_id) : null,
          recurrence: data.recurrence || '',
          memo: data.memo || ''
        });
        writeStore(store);
        return jsonResponse({ success: true });
      });
    }
    if (eventMatch && method === 'DELETE') {
      store.events = store.events.filter(item => Number(item.id) !== Number(eventMatch[1]));
      writeStore(store);
      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  };
}());
