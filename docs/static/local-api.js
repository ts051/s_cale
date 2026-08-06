(function () {
  const COLORS = ['#1aa260', '#e67c73', '#f4511e', '#1a73e8', '#8e24aa', '#f6bf26', '#039be5', '#33b679', '#0b8043', '#3f51b5'];
  const config = window.WHITE_TREE_SUPABASE || {};
  const nativeFetch = window.fetch.bind(window);
  const isConfigured = !!(config.url && config.anonKey && window.supabase);
  const client = isConfigured ? window.supabase.createClient(config.url, config.anonKey) : null;
  const INTERNAL_EMAIL_DOMAIN = 'whitetree.example.com';
  const LEGACY_EMAIL_DOMAIN = 'whitetree.local';

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register = function () {
      return Promise.resolve({ scope: location.href });
    };
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

  async function bodyJson(input, init) {
    if (init?.body) return JSON.parse(init.body);
    if (typeof input !== 'string' && input.body) return JSON.parse(await input.text());
    return {};
  }

  function normalizeUsername(username) {
    return String(username || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._+-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function usernameToEmail(username) {
    return `${normalizeUsername(username) || 'user'}@${INTERNAL_EMAIL_DOMAIN}`;
  }

  function usernameToLegacyEmail(username) {
    return `${normalizeUsername(username) || 'user'}@${LEGACY_EMAIL_DOMAIN}`;
  }

  function emailLocalPart(email) {
    return normalizeUsername(String(email || '').split('@')[0]);
  }

  function isMissingLoginIdsTable(error) {
    const message = String(error?.message || '').toLowerCase();
    return error?.code === '42P01'
      || error?.code === 'PGRST205'
      || message.includes('relation "public.login_ids" does not exist')
      || (message.includes('schema cache') && message.includes('login_ids'))
      || (message.includes('could not find') && message.includes('login_ids'));
  }

  async function lookupLoginId(username) {
    try {
      const { data, error } = await client
        .from('login_ids')
        .select('auth_email, is_active')
        .eq('login_id', normalizeUsername(username))
        .maybeSingle();
      if (error) throw error;
      if (!data) return { email: null, blocked: false };
      return { email: data.is_active ? data.auth_email : null, blocked: !data.is_active };
    } catch (error) {
      if (!isMissingLoginIdsTable(error)) console.warn('Login ID lookup failed:', error);
      return { email: null, blocked: false };
    }
  }

  async function replaceLoginId(user, loginId, previousLoginId, required) {
    const normalized = normalizeUsername(loginId);
    if (!normalized) return;

    const authEmail = user.email || usernameToLegacyEmail(normalized);
    const rows = [{
      login_id: normalized,
      user_id: user.id,
      auth_email: authEmail,
      is_active: true
    }];

    for (const oldLoginId of [previousLoginId, emailLocalPart(user.email)]) {
      const oldNormalized = normalizeUsername(oldLoginId);
      if (oldNormalized && oldNormalized !== normalized && !rows.some(row => row.login_id === oldNormalized)) {
        rows.push({
          login_id: oldNormalized,
          user_id: user.id,
          auth_email: null,
          is_active: false
        });
      }
    }

    const { error: upsertError } = await client
      .from('login_ids')
      .upsert(rows, { onConflict: 'login_id' });
    if (upsertError) {
      if (required && isMissingLoginIdsTable(upsertError)) {
        throw new Error('ログインID管理テーブルが未設定です。supabase/schema.sql を Supabase に適用してください。');
      }
      if (required || !isMissingLoginIdsTable(upsertError)) throw upsertError;
      return;
    }

    const { error: retireError } = await client
      .from('login_ids')
      .update({ auth_email: null, is_active: false })
      .eq('user_id', user.id)
      .neq('login_id', normalized);
    if (retireError) {
      if (required && isMissingLoginIdsTable(retireError)) {
        throw new Error('ログインID管理テーブルが未設定です。supabase/schema.sql を Supabase に適用してください。');
      }
      if (required || !isMissingLoginIdsTable(retireError)) throw retireError;
    }
  }

  async function signInWithUsername(username, password) {
    const loginId = await lookupLoginId(username);
    if (loginId.blocked) return { error: new Error('Login ID has been changed.') };

    const emails = [loginId.email, usernameToEmail(username), usernameToLegacyEmail(username)].filter(Boolean);
    let lastError = null;
    for (const email of [...new Set(emails)]) {
      const result = await client.auth.signInWithPassword({ email, password });
      if (!result.error) return result;
      lastError = result.error;
    }
    return { error: lastError };
  }

  async function getSessionUser() {
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session?.user || null;
  }

  async function getProfile(user) {
    const { data, error } = await client
      .from('profiles')
      .select('id, username, week_start')
      .eq('id', user.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function ensureProfile(user, username) {
    let profile = await getProfile(user);
    if (profile) return profile;

    const nextProfile = {
      id: user.id,
      username: username || user.email?.split('@')[0] || 'user',
      week_start: 1
    };
    const { data, error } = await client
      .from('profiles')
      .insert(nextProfile)
      .select('id, username, week_start')
      .single();
    if (error) throw error;
    return data;
  }

  async function currentProfileResponse() {
    if (!isConfigured) {
      return { logged_in: false, error: 'Supabase is not configured.' };
    }
    const user = await getSessionUser();
    if (!user) return { logged_in: false };
    const profile = await ensureProfile(user);
    await ensureDefaultLabels(user.id);
    return {
      logged_in: true,
      user_id: user.id,
      username: profile.username,
      week_start: profile.week_start === 0 ? 0 : 1
    };
  }

  async function ensureDefaultLabels(userId) {
    const { data: labels, error } = await client
      .from('labels')
      .select('id, is_shared, owner_id')
      .or(`is_shared.eq.true,owner_id.eq.${userId}`);
    if (error) throw error;

    const hasShared = labels.some(label => label.is_shared);
    const hasPrivate = labels.some(label => !label.is_shared && label.owner_id === userId);
    const rows = [];

    if (!hasShared) {
      for (let i = 1; i <= 10; i += 1) {
        rows.push({ owner_id: null, name: `ラベル${i}`, color: COLORS[i - 1], is_shared: true, sort_order: i });
      }
    }

    if (!hasPrivate) {
      for (let i = 1; i <= 10; i += 1) {
        rows.push({ owner_id: userId, name: `ラベル${i}`, color: COLORS[i - 1], is_shared: false, sort_order: i });
      }
    }

    if (rows.length > 0) {
      const { error: insertError } = await client.from('labels').insert(rows);
      if (insertError && insertError.code !== '23505') throw insertError;
    }
  }

  function addRecurrenceDate(date, recurrence) {
    const next = new Date(date.getTime());
    if (recurrence === 'weekly') next.setDate(next.getDate() + 7);
    if (recurrence === 'monthly') next.setMonth(next.getMonth() + 1);
    if (recurrence === 'yearly') next.setFullYear(next.getFullYear() + 1);
    return next;
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

  function compareDateTimeText(a, b) {
    return String(a || '').localeCompare(String(b || ''));
  }

  function formatDateOnly(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function addDaysText(dateText, days) {
    const [year, month, day] = dateText.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    date.setDate(date.getDate() + days);
    return formatDateOnly(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  function dayOfWeek(dateText) {
    const [year, month, day] = dateText.split('-').map(Number);
    return new Date(year, month - 1, day).getDay();
  }

  function nthMonday(year, month, nth) {
    const first = new Date(year, month - 1, 1);
    const offset = (8 - first.getDay()) % 7;
    return 1 + offset + (nth - 1) * 7;
  }

  function vernalEquinoxDay(year) {
    return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  function autumnalEquinoxDay(year) {
    return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  function addHoliday(holidayMap, year, month, day, title) {
    holidayMap.set(formatDateOnly(year, month, day), title);
  }

  function buildJapanHolidayMap(year) {
    const holidays = new Map();

    addHoliday(holidays, year, 1, 1, '元日');
    addHoliday(holidays, year, 1, nthMonday(year, 1, 2), '成人の日');
    addHoliday(holidays, year, 2, 11, '建国記念の日');
    addHoliday(holidays, year, 2, 23, '天皇誕生日');
    addHoliday(holidays, year, 3, vernalEquinoxDay(year), '春分の日');
    addHoliday(holidays, year, 4, 29, '昭和の日');
    addHoliday(holidays, year, 5, 3, '憲法記念日');
    addHoliday(holidays, year, 5, 4, 'みどりの日');
    addHoliday(holidays, year, 5, 5, 'こどもの日');
    addHoliday(holidays, year, 7, nthMonday(year, 7, 3), '海の日');
    addHoliday(holidays, year, 8, 11, '山の日');
    addHoliday(holidays, year, 9, nthMonday(year, 9, 3), '敬老の日');
    addHoliday(holidays, year, 9, autumnalEquinoxDay(year), '秋分の日');
    addHoliday(holidays, year, 10, nthMonday(year, 10, 2), 'スポーツの日');
    addHoliday(holidays, year, 11, 3, '文化の日');
    addHoliday(holidays, year, 11, 23, '勤労感謝の日');

    Array.from(holidays.keys()).sort().forEach(dateText => {
      if (dayOfWeek(dateText) !== 0) return;
      let substitute = addDaysText(dateText, 1);
      while (holidays.has(substitute)) {
        substitute = addDaysText(substitute, 1);
      }
      holidays.set(substitute, '振替休日');
    });

    const dates = Array.from(holidays.keys()).sort();
    for (let i = 0; i < dates.length - 1; i += 1) {
      const current = dates[i];
      const next = dates[i + 1];
      if (addDaysText(current, 2) === next) {
        const between = addDaysText(current, 1);
        if (!holidays.has(between) && dayOfWeek(between) !== 0) {
          holidays.set(between, '国民の休日');
        }
      }
    }

    return holidays;
  }

  function getJapanHolidays(searchParams) {
    const now = new Date();
    const years = new Set([now.getFullYear()]);
    const startLimit = searchParams.get('start');
    const endLimit = searchParams.get('end');

    [startLimit, endLimit].forEach(value => {
      const year = Number(String(value || '').slice(0, 4));
      if (Number.isFinite(year)) years.add(year);
    });

    const output = [];
    years.forEach(year => {
      buildJapanHolidayMap(year).forEach((title, dateText) => {
        if (startLimit && dateText < startLimit) return;
        if (endLimit && dateText >= endLimit) return;
        output.push({
          title,
          start: dateText,
          display: 'block',
          color: 'transparent',
          textColor: '#d93025',
          className: 'fc-event-holiday',
          allDay: true,
          extendedProps: {
            is_holiday: 1
          }
        });
      });
    });

    return output.sort((a, b) => a.start.localeCompare(b.start));
  }

  function isEventInRange(row, searchParams) {
    const startLimit = searchParams.get('start');
    const endLimit = searchParams.get('end');
    if (!startLimit || !endLimit || row.recurrence) return true;
    const startTime = row.start_time || '';
    const endTime = row.end_time || row.start_time || '';
    return compareDateTimeText(startTime, endLimit) <= 0 && compareDateTimeText(endTime, startLimit) >= 0;
  }

  function buildEventsFilter(userId, searchParams) {
    const startLimit = searchParams.get('start');
    const endLimit = searchParams.get('end');
    if (!startLimit || !endLimit) return `is_shared.eq.true,owner_id.eq.${userId}`;
    return [
      'and(is_shared.eq.true,recurrence.not.is.null)',
      `and(owner_id.eq.${userId},recurrence.not.is.null)`,
      `and(is_shared.eq.true,start_time.lte.${endLimit},end_time.gte.${startLimit})`,
      `and(owner_id.eq.${userId},start_time.lte.${endLimit},end_time.gte.${startLimit})`
    ].join(',');
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

  function toCalendarEvent(row, userId, labels) {
    const label = labels.find(item => Number(item.id) === Number(row.label_id));
    const color = label?.color || (row.is_shared ? '#1aa260' : '#1a73e8');
    return {
      id: row.id,
      title: row.title,
      start: row.start_time,
      end: row.end_time,
      allDay: !!row.is_all_day,
      backgroundColor: color,
      borderColor: color,
      textColor: '#ffffff',
      color,
      extendedProps: {
        original_id: row.id,
        is_shared: !!row.is_shared,
        is_mine: row.owner_id === userId,
        label_id: row.label_id,
        label_order: label?.sort_order || 999,
        recurrence: row.recurrence || null,
        occurrence_start: row.start_time,
        memo: row.memo || '',
        is_holiday: 0
      }
    };
  }

  function expandRecurrence(rows, userId, labels, searchParams) {
    const startLimit = parseDateTime(searchParams.get('start')) || new Date(new Date().getFullYear() - 1, 0, 1);
    const endLimit = parseDateTime(searchParams.get('end')) || new Date(new Date().getFullYear() + 1, 11, 31);
    const output = [];

    rows.forEach(row => {
      const base = toCalendarEvent(row, userId, labels);
      if (!row.recurrence) {
        output.push(base);
        return;
      }

      const start = parseDateTime(row.start_time);
      const end = parseDateTime(row.end_time);
      if (!start || !end) {
        output.push(base);
        return;
      }

      const duration = end.getTime() - start.getTime();
      const hasTime = row.start_time.includes('T');
      const recurrenceUntil = parseDateTime(row.recurrence_until);
      const recurrenceExceptions = new Set(Array.isArray(row.recurrence_exceptions) ? row.recurrence_exceptions : []);
      let current = new Date(start.getTime());
      let guard = 0;
      while (current <= endLimit && (!recurrenceUntil || current < recurrenceUntil) && guard < 1000) {
        const occurrenceStart = formatDateTime(current, hasTime);
        if (current >= startLimit && !recurrenceExceptions.has(occurrenceStart)) {
          const occurrence = JSON.parse(JSON.stringify(base));
          occurrence.id = `${row.id}_${formatDateTime(current, false).replaceAll('-', '')}`;
          occurrence.start = occurrenceStart;
          occurrence.end = formatDateTime(new Date(current.getTime() + duration), hasTime);
          occurrence.extendedProps.occurrence_start = occurrenceStart;
          output.push(occurrence);
        }
        current = addRecurrenceDate(current, row.recurrence);
        guard += 1;
      }
    });

    return output;
  }

  async function requireUser() {
    if (!isConfigured) {
      throw new Error('Supabase is not configured. Set docs/static/supabase-config.js.');
    }
    const user = await getSessionUser();
    if (!user) throw new Error('Unauthorized');
    await ensureDefaultLabels(user.id);
    return user;
  }

  async function fetchLabels(userId) {
    const { data, error } = await client
      .from('labels')
      .select('id, owner_id, name, color, is_shared, sort_order')
      .or(`is_shared.eq.true,owner_id.eq.${userId}`)
      .order('is_shared', { ascending: false })
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw error;
    return data.map(label => ({
      id: label.id,
      user_id: label.owner_id,
      name: label.name,
      color: label.color,
      is_shared: label.is_shared,
      sort_order: label.sort_order
    }));
  }

  async function selectAll(buildQuery, pageSize = 1000) {
    const rows = [];
    let from = 0;

    while (true) {
      const { data, error } = await buildQuery().range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }

    return rows;
  }

  async function fetchEvents(user, searchParams) {
    const { data: labels, error: labelError } = await client
      .from('labels')
      .select('id, color, sort_order');
    if (labelError) throw labelError;

    const eventsFilter = buildEventsFilter(user.id, searchParams);
    const rows = await selectAll(() => client
        .from('events')
        .select('id, owner_id, title, start_time, end_time, is_shared, is_all_day, label_id, recurrence, recurrence_until, recurrence_exceptions, memo')
        .or(eventsFilter)
        .order('id', { ascending: true }));
    return expandRecurrence(rows.filter(row => isEventInRange(row, searchParams)), user.id, labels, searchParams);
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
    return value.replaceAll('-', '').replaceAll(':', '');
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

  window.exportICSFile = async function () {
    try {
      const user = await requireUser();
      const rows = await selectAll(() => client
        .from('events')
        .select('id, title, start_time, end_time, is_shared, is_all_day, label_id, recurrence, memo')
        .or(`is_shared.eq.true,owner_id.eq.${user.id}`)
        .order('id', { ascending: true }));

      const { data: labels, error: labelError } = await client.from('labels').select('id, name');
      if (labelError) throw labelError;
      const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WhiteTree//Supabase Calendar//JA', 'CALSCALE:GREGORIAN'];
      rows.forEach(event => {
        const label = labels.find(item => Number(item.id) === Number(event.label_id));
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:whitetree-${event.id}@supabase`);
        lines.push(`DTSTAMP:${now}`);
        lines.push(event.is_all_day ? `DTSTART;VALUE=DATE:${toIcsDate(event.start_time, true)}` : `DTSTART:${toIcsDate(event.start_time, false)}`);
        lines.push(event.is_all_day ? `DTEND;VALUE=DATE:${toIcsDate(event.end_time, true)}` : `DTEND:${toIcsDate(event.end_time, false)}`);
        lines.push(foldIcsLine(`SUMMARY:${escapeIcs(event.title)}`));
        if (label) lines.push(foldIcsLine(`CATEGORIES:${escapeIcs(label.name)}`));
        if (event.memo) lines.push(foldIcsLine(`DESCRIPTION:${escapeIcs(event.memo)}`));
        if (event.recurrence) lines.push(`RRULE:FREQ=${event.recurrence.toUpperCase()}`);
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
    } catch (error) {
      console.error(error);
      alert(`エクスポートに失敗しました: ${error.message}`);
    }
  };

  window.importICSFile = async function () {
    const input = document.getElementById('icsFileInput');
    if (!input || input.files.length === 0) {
      alert('ICSファイルを選択してください');
      return;
    }

    try {
      const user = await requireUser();
      const labels = await fetchLabels(user.id);
      const text = await input.files[0].text();
      const unfolded = text.replace(/\r?\n[ \t]/g, '');
      const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
      const rows = [];

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
          ? labels.find(item => item.name === category && (isShared ? item.is_shared : !item.is_shared))
          : null;
        const rrule = String(fields.RRULE || '').toUpperCase();
        let recurrence = null;
        if (rrule.includes('FREQ=WEEKLY')) recurrence = 'weekly';
        if (rrule.includes('FREQ=MONTHLY')) recurrence = 'monthly';
        if (rrule.includes('FREQ=YEARLY')) recurrence = 'yearly';

        rows.push({
          owner_id: user.id,
          title: unescapeIcs(fields.SUMMARY),
          start_time: start.value,
          end_time: end.value || start.value,
          is_all_day: start.allDay,
          is_shared: isShared,
          label_id: label?.id || null,
          recurrence,
          memo: unescapeIcs(fields.DESCRIPTION || '')
        });
      });

      if (rows.length > 0) {
        const { error } = await client.from('events').insert(rows);
        if (error) throw error;
      }
      input.value = '';
      alert(`${rows.length} 件の予定をインポートしました。`);
      if (typeof toggleDrawer === 'function') toggleDrawer(false);
      if (typeof refreshEvents === 'function') refreshEvents();
    } catch (error) {
      console.error(error);
      alert(`インポートに失敗しました: ${error.message}`);
    }
  };

  window.fetch = async function (input, init) {
    const pathWithSearch = normalizePath(input);
    if (!pathWithSearch.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    const url = new URL(pathWithSearch, location.href);
    const path = url.pathname;
    const method = ((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();

    try {
      if (path === '/api/me' && method === 'GET') {
        return jsonResponse(await currentProfileResponse());
      }

      if (path === '/api/holidays' && method === 'GET') {
        return jsonResponse(getJapanHolidays(url.searchParams));
      }

      if (!isConfigured) {
        return jsonResponse({ error: 'Supabase is not configured. Set docs/static/supabase-config.js.' }, 503);
      }

      if (path === '/api/login' && method === 'POST') {
        const data = await bodyJson(input, init);
        const username = normalizeUsername(data.username);
        const password = String(data.password || '');
        if (!username) {
          return jsonResponse({ success: false, error: 'ユーザー名を入力してください。' });
        }
        const result = await signInWithUsername(username, password);
        if (result.error) {
          return jsonResponse({ success: false, error: 'ユーザー名またはパスワードが違います。' });
        }

        const user = result.data.user || result.data.session?.user;
        const profile = await ensureProfile(user, username);
        await replaceLoginId(user, profile.username, username, false);
        await ensureDefaultLabels(user.id);
        return jsonResponse({ success: true, user_id: user.id, username: profile.username, week_start: profile.week_start });
      }

      if (path === '/api/logout' && method === 'POST') {
        await client.auth.signOut();
        return jsonResponse({ success: true });
      }

      const user = await requireUser();

      if (path === '/api/settings' && method === 'PUT') {
        const data = await bodyJson(input, init);
        const username = normalizeUsername(data.username);
        const password = String(data.password || '');
        if (!username) {
          return jsonResponse({ success: false, error: 'ユーザー名は英数字で入力してください。' });
        }
        const profile = await ensureProfile(user);
        if (password) {
          const { error } = await client.auth.updateUser({ password });
          if (error) throw error;
        }
        await replaceLoginId(user, username, profile.username, true);
        const { error } = await client.from('profiles').update({ username }).eq('id', user.id);
        if (error) throw error;
        return jsonResponse({ success: true, username });
      }

      if (path === '/api/preferences' && method === 'PUT') {
        const data = await bodyJson(input, init);
        const weekStart = Number(data.week_start) === 0 ? 0 : 1;
        const { error } = await client.from('profiles').update({ week_start: weekStart }).eq('id', user.id);
        if (error) throw error;
        return jsonResponse({ success: true, week_start: weekStart });
      }

      if (path === '/api/labels' && method === 'GET') {
        return jsonResponse(await fetchLabels(user.id));
      }

      if (path === '/api/labels' && method === 'POST') {
        return jsonResponse({ success: false, error: '最大10個の固定ラベル枠仕様のため、新規作成はできません。既存のラベルを編集してください。' });
      }

      if (path === '/api/labels/reorder' && method === 'PUT') {
        const data = await bodyJson(input, init);
        const ids = data.label_ids || [];
        for (let index = 0; index < ids.length; index += 1) {
          const { error } = await client.from('labels').update({ sort_order: index + 1 }).eq('id', ids[index]);
          if (error) throw error;
        }
        return jsonResponse({ success: true });
      }

      const labelMatch = path.match(/^\/api\/labels\/(\d+)$/);
      if (labelMatch && method === 'PUT') {
        const data = await bodyJson(input, init);
        const { error } = await client
          .from('labels')
          .update({ name: data.name, color: data.color })
          .eq('id', Number(labelMatch[1]));
        if (error) throw error;
        return jsonResponse({ success: true });
      }
      if (labelMatch && method === 'DELETE') {
        const labels = await fetchLabels(user.id);
        const label = labels.find(item => Number(item.id) === Number(labelMatch[1]));
        if (!label) return jsonResponse({ error: 'Not found' }, 404);
        const siblings = labels.filter(item => item.is_shared === label.is_shared).sort((a, b) => (a.sort_order || 999) - (b.sort_order || 999));
        const index = Math.max(0, siblings.findIndex(item => Number(item.id) === Number(label.id)));
        const { error } = await client
          .from('labels')
          .update({ name: `ラベル${index + 1}`, color: COLORS[index % COLORS.length] })
          .eq('id', Number(labelMatch[1]));
        if (error) throw error;
        return jsonResponse({ success: true });
      }

      if (path === '/api/events' && method === 'GET') {
        return jsonResponse(await fetchEvents(user, url.searchParams));
      }

      if (path === '/api/events' && method === 'POST') {
        const data = await bodyJson(input, init);
        const row = {
          owner_id: user.id,
          title: data.title,
          start_time: data.start,
          end_time: data.end,
          is_shared: !!data.is_shared,
          is_all_day: !!(data.allDay || data.is_all_day),
          label_id: data.label_id ? Number(data.label_id) : null,
          recurrence: data.recurrence || null,
          memo: data.memo || ''
        };
        const { data: inserted, error } = await client.from('events').insert(row).select('id').single();
        if (error) throw error;
        return jsonResponse({ success: true, id: inserted.id });
      }

      if (path === '/api/events/clear' && method === 'DELETE') {
        const rows = await selectAll(() => client
          .from('events')
          .select('id')
          .or(`is_shared.eq.true,owner_id.eq.${user.id}`)
          .order('id', { ascending: true }));
        const ids = rows.map(row => row.id);
        if (ids.length > 0) {
          const { error: deleteError } = await client.from('events').delete().in('id', ids);
          if (deleteError) throw deleteError;
        }
        return jsonResponse({ success: true });
      }

      const eventMatch = path.match(/^\/api\/events\/(\d+)$/);
      if (eventMatch && method === 'PUT') {
        const eventId = Number(eventMatch[1]);
        const data = await bodyJson(input, init);
        const row = {
          title: data.title,
          start_time: data.start,
          end_time: data.end,
          is_shared: !!data.is_shared,
          is_all_day: !!(data.allDay || data.is_all_day),
          label_id: data.label_id ? Number(data.label_id) : null,
          recurrence: data.recurrence || null,
          memo: data.memo || ''
        };
        const scope = data.scope || 'all';
        const occurrenceStart = data.occurrence_start;
        const { data: event, error: selectError } = await client
          .from('events')
          .select('id, owner_id, start_time, end_time, recurrence, recurrence_until, recurrence_exceptions')
          .eq('id', eventId)
          .single();
        if (selectError) throw selectError;

        if (event.recurrence && (scope === 'single' || scope === 'future')) {
          if (!occurrenceStart || occurrenceStart < event.start_time) {
            return jsonResponse({ error: 'Invalid occurrence_start' }, 400);
          }

          const insertedRow = {
            ...row,
            owner_id: user.id,
            recurrence: scope === 'single' ? null : row.recurrence
          };
          const { data: inserted, error: insertError } = await client
            .from('events')
            .insert(insertedRow)
            .select('id')
            .single();
          if (insertError) throw insertError;

          let seriesError = null;
          if (scope === 'single') {
            const exceptions = Array.isArray(event.recurrence_exceptions) ? event.recurrence_exceptions.slice() : [];
            if (!exceptions.includes(occurrenceStart)) exceptions.push(occurrenceStart);
            ({ error: seriesError } = await client.from('events').update({ recurrence_exceptions: exceptions }).eq('id', eventId));
          } else if (occurrenceStart === event.start_time) {
            ({ error: seriesError } = await client.from('events').delete().eq('id', eventId));
          } else {
            ({ error: seriesError } = await client.from('events').update({ recurrence_until: occurrenceStart }).eq('id', eventId));
          }

          if (seriesError) {
            await client.from('events').delete().eq('id', inserted.id);
            throw seriesError;
          }
          return jsonResponse({ success: true, id: inserted.id });
        }

        if (event.recurrence && occurrenceStart && row.recurrence) {
          const occurrenceDate = parseDateTime(occurrenceStart);
          const editedStart = parseDateTime(row.start_time);
          const editedEnd = parseDateTime(row.end_time);
          const baseStart = parseDateTime(event.start_time);
          if (!occurrenceDate || !editedStart || !editedEnd || !baseStart) {
            return jsonResponse({ error: 'Invalid event datetime' }, 400);
          }
          const delta = editedStart.getTime() - occurrenceDate.getTime();
          const duration = editedEnd.getTime() - editedStart.getTime();
          const adjustedBaseStart = new Date(baseStart.getTime() + delta);
          const hasTime = row.start_time.includes('T');
          row.start_time = formatDateTime(adjustedBaseStart, hasTime);
          row.end_time = formatDateTime(new Date(adjustedBaseStart.getTime() + duration), hasTime);

          row.recurrence_exceptions = (Array.isArray(event.recurrence_exceptions) ? event.recurrence_exceptions : [])
            .map(value => parseDateTime(value))
            .filter(Boolean)
            .map(value => formatDateTime(new Date(value.getTime() + delta), hasTime));
          const untilDate = parseDateTime(event.recurrence_until);
          row.recurrence_until = untilDate
            ? formatDateTime(new Date(untilDate.getTime() + delta), hasTime)
            : null;
        }
        if (!row.recurrence) {
          row.recurrence_exceptions = [];
          row.recurrence_until = null;
        }

        const { error } = await client.from('events').update(row).eq('id', eventId);
        if (error) throw error;
        return jsonResponse({ success: true });
      }
      if (eventMatch && method === 'DELETE') {
        const eventId = Number(eventMatch[1]);
        const data = await bodyJson(input, init);
        const scope = data.scope || 'all';
        const { data: event, error: selectError } = await client
          .from('events')
          .select('id, start_time, recurrence, recurrence_exceptions')
          .eq('id', eventId)
          .single();
        if (selectError) throw selectError;

        if (event.recurrence && (scope === 'single' || scope === 'future')) {
          const occurrenceStart = data.occurrence_start;
          if (!occurrenceStart || occurrenceStart < event.start_time) {
            return jsonResponse({ error: 'Invalid occurrence_start' }, 400);
          }
          if (scope === 'single') {
            const exceptions = Array.isArray(event.recurrence_exceptions) ? event.recurrence_exceptions.slice() : [];
            if (!exceptions.includes(occurrenceStart)) exceptions.push(occurrenceStart);
            const { error } = await client.from('events').update({ recurrence_exceptions: exceptions }).eq('id', eventId);
            if (error) throw error;
          } else if (occurrenceStart === event.start_time) {
            const { error } = await client.from('events').delete().eq('id', eventId);
            if (error) throw error;
          } else {
            const { error } = await client.from('events').update({ recurrence_until: occurrenceStart }).eq('id', eventId);
            if (error) throw error;
          }
        } else {
          const { error } = await client.from('events').delete().eq('id', eventId);
          if (error) throw error;
        }
        return jsonResponse({ success: true });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      const status = error.message === 'Unauthorized' ? 401 : 500;
      return jsonResponse({ success: false, error: error.message || String(error) }, status);
    }
  };
}());
