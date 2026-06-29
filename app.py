import os
import sqlite3
import logging
import copy
import re
from flask import Flask, render_template, request, jsonify, session, redirect, url_for, flash, make_response
from werkzeug.security import generate_password_hash, check_password_hash
import holidays
from datetime import datetime, timedelta

app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'super-secret-key-for-dev')
app.json.ensure_ascii = False
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=90)
logging.getLogger('werkzeug').setLevel(logging.WARNING)

DATABASE = 'database.db'

def normalize_date_string(value):
    try:
        return datetime.strptime(value, '%Y-%m-%d').strftime('%Y-%m-%d')
    except (TypeError, ValueError):
        return value

def escape_ics_text(value):
    return (value or '').replace('\\', '\\\\').replace('\n', '\\n').replace(',', '\\,').replace(';', '\\;')

def unescape_ics_text(value):
    return (value or '').replace('\\n', '\n').replace('\\N', '\n').replace('\\,', ',').replace('\\;', ';').replace('\\\\', '\\')

def fold_ics_line(line):
    chunks = []
    rest = line
    while len(rest) > 74:
        chunks.append(rest[:74])
        rest = ' ' + rest[74:]
    chunks.append(rest)
    return '\r\n'.join(chunks)

def format_ics_datetime(value, is_all_day):
    if not value:
        return ''
    if is_all_day:
        return value.split('T')[0].replace('-', '')
    return value.replace('-', '').replace(':', '')

def parse_ics_datetime(value):
    raw = (value or '').strip()
    if re.match(r'^\d{8}$', raw):
        return f'{raw[0:4]}-{raw[4:6]}-{raw[6:8]}', True
    match = re.match(r'^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})', raw)
    if not match:
        return '', False
    return f'{match.group(1)}-{match.group(2)}-{match.group(3)}T{match.group(4)}:{match.group(5)}:{match.group(6)}', False

def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT NOT NULL,
                is_shared INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        ''')
        
        # 繝ｩ繝吶Ν邂｡逅・ユ繝ｼ繝悶Ν
        conn.execute('''
            CREATE TABLE IF NOT EXISTS labels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                is_shared INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0
            )
        ''')
        
        try:
            conn.execute('ALTER TABLE users ADD COLUMN week_start INTEGER NOT NULL DEFAULT 1')
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute('ALTER TABLE events ADD COLUMN label_id INTEGER')
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute('ALTER TABLE events ADD COLUMN is_all_day INTEGER DEFAULT 1')
        except sqlite3.OperationalError:
            pass
        
        # 譌｢蟄倥・ events 繝・・繝悶Ν縺ｫ recurrence 繧ｫ繝ｩ繝縺後↑縺代ｌ縺ｰ霑ｽ蜉縺吶ｋ
        try:
            conn.execute('ALTER TABLE events ADD COLUMN recurrence TEXT DEFAULT NULL')
            conn.commit()
        except sqlite3.OperationalError:
            # 譌｢縺ｫ繧ｫ繝ｩ繝縺悟ｭ伜惠縺吶ｋ蝣ｴ蜷医・繧ｨ繝ｩ繝ｼ繧堤┌隕悶＠縺ｾ縺・
            pass
        
        try:
            conn.execute('ALTER TABLE events ADD COLUMN memo TEXT')
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute('ALTER TABLE labels ADD COLUMN sort_order INTEGER DEFAULT 0')
        except sqlite3.OperationalError:
            pass

        conn.execute('''
            UPDATE events
            SET end_time = date(end_time, '+1 day')
            WHERE is_all_day = 1
              AND start_time = end_time
              AND end_time GLOB '????-??-??'
        ''')
        same_day_all_day_rows = conn.execute('''
            SELECT id, start_time, end_time
            FROM events
            WHERE is_all_day = 1
              AND start_time = end_time
        ''').fetchall()
        for row in same_day_all_day_rows:
            try:
                start_dt = datetime.strptime(row['start_time'], '%Y-%m-%d')
            except (TypeError, ValueError):
                continue

            conn.execute(
                'UPDATE events SET start_time = ?, end_time = ? WHERE id = ?',
                (
                    start_dt.strftime('%Y-%m-%d'),
                    (start_dt + timedelta(days=1)).strftime('%Y-%m-%d'),
                    row['id']
                )
            )

        conn.commit()

init_db()

def create_initial_users():
    with get_db() as conn:
        for username in ['husband', 'wife']:
            try:
                hashed = generate_password_hash('password')
                conn.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', (username, hashed))
                conn.commit()
            except sqlite3.IntegrityError:
                pass

create_initial_users()

def create_default_labels():
    """
    蜈ｱ騾壹き繝ｬ繝ｳ繝繝ｼ逕ｨ・・ser_id=0, is_shared=1・峨↓10蛟九・
    蛟倶ｺｺ繧ｫ繝ｬ繝ｳ繝繝ｼ逕ｨ・亥推user_id, is_shared=0・峨↓縺昴ｌ縺槭ｌ10蛟九・蝗ｺ螳壽棧・医せ繝ｭ繝・ヨ・峨ｒ蛻晄悄蛹悶・邯ｭ謖√＠縺ｾ縺吶・
    譌｢縺ｫ繝・・繧ｿ繝吶・繧ｹ縺悟ｭ伜惠縺吶ｋ蝣ｴ蜷医・陦晉ｪ√お繝ｩ繝ｼ繧貞ｮ牙・縺ｫ蝗樣∩縺励∪縺吶・
    """
    default_colors = [
        '#1aa260', '#e67c73', '#f4511e', '#1a73e8', '#8e24aa',
        '#f6bf26', '#039be5', '#33b679', '#0b8043', '#3f51b5'
    ]
    
    with get_db() as conn:
        # 1. 蜈ｱ騾壹Λ繝吶Ν・・ser_id=0, is_shared=1・画棧縺ｮ荳崎ｶｳ蛻・ｒ陬懷・
        for i in range(1, 11):
            label_name = f'繝ｩ繝吶Ν{i}'
            # 蜷悟錐縲√∪縺溘・譫縺ｨ縺励※繧ｫ繧ｦ繝ｳ繝亥庄閭ｽ縺ｪ迥ｶ諷九°繧偵メ繧ｧ繝・け
            exists = conn.execute(
                'SELECT id FROM labels WHERE user_id = 0 AND is_shared = 1 AND name = ?', (label_name,)
            ).fetchone()
            if not exists:
                # 迴ｾ蝨ｨ縺ｮ蜈ｱ騾壹Λ繝吶Ν縺ｮ繝医・繧ｿ繝ｫ譫謨ｰ繧堤｢ｺ隱・
                current_cnt = conn.execute(
                    'SELECT COUNT(*) as cnt FROM labels WHERE user_id = 0 AND is_shared = 1'
                ).fetchone()['cnt']
                if current_cnt < 10:
                    color = default_colors[(i - 1) % len(default_colors)]
                    conn.execute(
                        'INSERT INTO labels (user_id, name, color, is_shared, sort_order) VALUES (?, ?, ?, ?, ?)',
                        (0, label_name, color, 1, i)
                    )
        
        # 2. 蜷・Θ繝ｼ繧ｶ繝ｼ逕ｨ縺ｮ蛟倶ｺｺ蛟句挨繝ｩ繝吶Ν・・ser_id縺斐→縺ｫ10蛟具ｼ画棧縺ｮ荳崎ｶｳ蛻・ｒ陬懷・
        users = conn.execute('SELECT id FROM users').fetchall()
        for u in users:
            uid = u['id']
            for i in range(1, 11):
                label_name = f'繝ｩ繝吶Ν{i}'
                exists = conn.execute(
                    'SELECT id FROM labels WHERE user_id = ? AND is_shared = 0 AND name = ?', (uid, label_name)
                ).fetchone()
                if not exists:
                    current_cnt = conn.execute(
                        'SELECT COUNT(*) as cnt FROM labels WHERE user_id = ? AND is_shared = 0', (uid,)
                    ).fetchone()['cnt']
                    if current_cnt < 10:
                        color = default_colors[(i - 1) % len(default_colors)]
                        conn.execute(
                            'INSERT INTO labels (user_id, name, color, is_shared, sort_order) VALUES (?, ?, ?, ?, ?)',
                            (uid, label_name, color, 0, i)
                        )
        label_groups = conn.execute('''
            SELECT is_shared, COALESCE(user_id, 0) as owner_id
            FROM labels
            GROUP BY is_shared, COALESCE(user_id, 0)
        ''').fetchall()
        for group in label_groups:
            if group['is_shared'] == 1:
                rows = conn.execute(
                    'SELECT id FROM labels WHERE is_shared = 1 ORDER BY sort_order ASC, id ASC'
                ).fetchall()
            else:
                rows = conn.execute(
                    'SELECT id FROM labels WHERE is_shared = 0 AND user_id = ? ORDER BY sort_order ASC, id ASC',
                    (group['owner_id'],)
                ).fetchall()
            for index, row in enumerate(rows, start=1):
                conn.execute('UPDATE labels SET sort_order = ? WHERE id = ?', (index, row['id']))
        conn.commit()

create_default_labels()


# --- 繝ｫ繝ｼ繝・ぅ繝ｳ繧ｰ ---

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/service-worker.js')
def service_worker():
    response = make_response(app.send_static_file('service-worker.js'))
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['Service-Worker-Allowed'] = '/'
    return response


@app.after_request
def add_api_cache_headers(response):
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store, max-age=0'
        response.headers['Pragma'] = 'no-cache'
    return response


# --- SPA逕ｨ隱崎ｨｼ繝ｻ險ｭ螳夂畑霑ｽ蜉API繧ｨ繝ｳ繝峨・繧､繝ｳ繝・---

@app.route('/api/me', methods=['GET'])
def get_current_user():
    if 'user_id' not in session:
        return jsonify({'logged_in': False}), 200
    
    current_user_id = session['user_id']
    with get_db() as conn:
        user = conn.execute('SELECT id, username, week_start FROM users WHERE id = ?', (current_user_id,)).fetchone()
    if user:
        return jsonify({
            'logged_in': True,
            'user_id': user['id'],
            'username': user['username'],
            'week_start': user['week_start']
        })
    return jsonify({'logged_in': False}), 200

@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.json or {}
    username = data.get('username')
    password = data.get('password')
    
    with get_db() as conn:
        user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
        
    if user and check_password_hash(user['password_hash'], password):
        session.permanent = True
        session['user_id'] = user['id']
        session['username'] = user['username']
        create_default_labels()
        return jsonify({
            'success': True,
            'user_id': user['id'],
            'username': user['username'],
            'week_start': user['week_start']
        })
    else:
        return jsonify({'success': False, 'error': 'ユーザー名またはパスワードが違います。'})

@app.route('/api/logout', methods=['POST'])
def api_logout():
    session.clear()
    return jsonify({'success': True})

@app.route('/api/settings', methods=['PUT'])
def api_update_settings():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    current_user_id = session['user_id']
    data = request.json or {}
    new_username = data.get('username')
    new_password = data.get('password')
    
    if not new_username:
        return jsonify({'success': False, 'error': 'ユーザー名は必須です。'})
        
    with get_db() as conn:
        try:
            conn.execute('UPDATE users SET username = ? WHERE id = ?', (new_username, current_user_id))
            
            if new_password:
                new_hashed = generate_password_hash(new_password)
                conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', (new_hashed, current_user_id))
            
            conn.commit()
            session['username'] = new_username
            return jsonify({'success': True, 'username': new_username})
            
        except sqlite3.IntegrityError:
            return jsonify({'success': False, 'error': 'そのユーザー名は既に使われています。'})


@app.route('/api/preferences', methods=['PUT'])
def api_update_preferences():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401

    data = request.json or {}
    week_start = data.get('week_start')
    if week_start not in (0, 1):
        return jsonify({'success': False, 'error': '週の開始曜日が不正です。'}), 400

    with get_db() as conn:
        conn.execute(
            'UPDATE users SET week_start = ? WHERE id = ?',
            (week_start, session['user_id'])
        )
        conn.commit()
    return jsonify({'success': True, 'week_start': week_start})


# --- API 繧ｨ繝ｳ繝峨・繧､繝ｳ繝・---
@app.route('/api/events', methods=['GET'])
def get_events():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    current_user_id = session['user_id']
    start_param = request.args.get('start')
    end_param = request.args.get('end')

    now = datetime.now()
    view_start = now - timedelta(days=365)
    view_end = now + timedelta(days=365)

    try:
        if start_param:
            view_start = datetime.strptime(start_param[:10], '%Y-%m-%d')
        if end_param:
            view_end = datetime.strptime(end_param[:10], '%Y-%m-%d')
    except (TypeError, ValueError):
        view_start = now - timedelta(days=365)
        view_end = now + timedelta(days=365)
    
    with get_db() as conn:
        params = [current_user_id]
        range_clause = ''
        if start_param and end_param:
            range_clause = '''
                AND (
                    e.recurrence IS NOT NULL
                    OR (
                        substr(e.start_time, 1, 10) < ?
                        AND substr(e.end_time, 1, 10) >= ?
                    )
                )
            '''
            params.extend([end_param[:10], start_param[:10]])

        rows = conn.execute(f'''
            SELECT e.id, e.title, e.memo,e.start_time as start, e.end_time as end, e.is_shared, e.user_id, e.is_all_day, e.label_id, e.recurrence, l.color as label_color, l.sort_order as label_sort_order
            FROM events e
            LEFT JOIN labels l ON e.label_id = l.id
            WHERE (e.is_shared = 1 OR e.user_id = ?)
            {range_clause}
        ''', params).fetchall()
        
    events = []

    def append_calendar_event(target, event):
        if not event.get('allDay') or not event.get('start') or not event.get('end'):
            target.append(event)
            return

        try:
            start_dt = datetime.strptime(event['start'].split('T')[0], '%Y-%m-%d')
            end_dt = datetime.strptime(event['end'].split('T')[0], '%Y-%m-%d')
        except (TypeError, ValueError):
            target.append(event)
            return

        if end_dt <= start_dt + timedelta(days=1):
            target.append(event)
            return

        current_dt = start_dt
        segment_index = 0
        total_segments = (end_dt - start_dt).days
        while current_dt < end_dt:
            segment = copy.deepcopy(event)
            current_str = current_dt.strftime('%Y-%m-%d')
            segment_classes = ['multi-day-segment']
            if segment_index == 0:
                segment_classes.append('multi-day-segment-start')
            elif segment_index == total_segments - 1:
                segment_classes.append('multi-day-segment-end')
                segment_classes.append('multi-day-segment-continuation')
            else:
                segment_classes.append('multi-day-segment-middle')
                segment_classes.append('multi-day-segment-continuation')

            segment['id'] = f"{event['id']}__day_{current_str}"
            segment['start'] = current_str
            segment['end'] = (current_dt + timedelta(days=1)).strftime('%Y-%m-%d')
            segment['display'] = 'block'
            segment['className'] = ' '.join(segment_classes)
            segment['extendedProps']['original_id'] = event['extendedProps'].get('original_id', event['id'])
            segment['extendedProps']['multi_day_segment_index'] = segment_index
            target.append(segment)
            current_dt += timedelta(days=1)
            segment_index += 1
    
    for row in rows:
        default_color = '#1aa260' if row['is_shared'] else '#1a73e8'
        event_color = row['label_color'] if row['label_color'] else default_color
        
        base_event = {
            'id': row['id'],
            'title': row['title'],
            'start': row['start'],
            'end': row['end'],
            'allDay': bool(row['is_all_day']),
            'backgroundColor': event_color,
            'borderColor': event_color,
            'textColor': '#ffffff',
            'color': event_color,
            'extendedProps': {
                'original_id': row['id'],
                'is_shared': bool(row['is_shared']),
                'is_mine': row['user_id'] == current_user_id,
                'label_id': row['label_id'],
                'label_order': row['label_sort_order'] if row['label_sort_order'] is not None else 999,
                'recurrence': row['recurrence'],
                'memo': row['memo'],
                'is_holiday': 0
            }
        } 


        # 郢ｰ繧願ｿ斐＠險ｭ螳壹′縺ｪ縺・ｴ蜷医・縺昴・縺ｾ縺ｾ霑ｽ蜉
        if not row['recurrence']:
            append_calendar_event(events, base_event)
            continue
            
        # 郢ｰ繧願ｿ斐＠險ｭ螳夲ｼ・eekly, monthly, yearly・峨′縺ゅｋ蝣ｴ蜷医・螻暮幕繝ｭ繧ｸ繝・け
        recurrence_type = row['recurrence']
        
        try:
            # ISO蠖｢蠑上・譁・ｭ怜・・井ｾ・ 2026-04-12T10:00:00 縺ｾ縺溘・ 2026-04-12・峨ｒ譌･譎ゅ↓繝代・繧ｹ
            if 'T' in row['start']:
                start_dt = datetime.strptime(row['start'], '%Y-%m-%dT%H:%M:%S')
                end_dt = datetime.strptime(row['end'], '%Y-%m-%dT%H:%M:%S')
                has_time = True
            else:
                start_dt = datetime.strptime(row['start'], '%Y-%m-%d')
                end_dt = datetime.strptime(row['end'], '%Y-%m-%d')
                has_time = False
        except Exception:
            # 荳・′荳繝代・繧ｹ縺ｫ螟ｱ謨励＠縺溷ｴ蜷医・縺昴・縺ｾ縺ｾ1莉ｶ縺縺題｡ｨ遉ｺ縺励※繧ｹ繧ｭ繝・・
            events.append(base_event)
            continue
            
        duration = end_dt - start_dt
        current_start = start_dt
        
        # 郢ｰ繧願ｿ斐＠莠亥ｮ壹ｒ譛滄俣蜀・↓隍・｣ｽ縺励※螻暮幕驟咲ｽｮ縺吶ｋ繝ｫ繝ｼ繝・
        # ・域怙蛻昴・1莉ｶ逶ｮ縺ｯ蜈・・菴咲ｽｮ縲∽ｻ･髯阪ｒ險ｭ螳壹↓蠢懊§縺ｦ譛ｪ譚･縺ｸ縺壹ｉ縺励↑縺後ｉ繧ｳ繝斐・繧堤函謌撰ｼ・
        while current_start <= view_end:
            if current_start >= view_start:
                # 逕ｻ髱｢騾∽ｿ｡逕ｨ繝輔か繝ｼ繝槭ャ繝医↓蜀榊､画鋤
                if has_time:
                    start_str = current_start.strftime('%Y-%m-%dT%H:%M:%S')
                    end_str = (current_start + duration).strftime('%Y-%m-%dT%H:%M:%S')
                else:
                    start_str = current_start.strftime('%Y-%m-%d')
                    end_str = (current_start + duration).strftime('%Y-%m-%d')

                copied_event = copy.deepcopy(base_event)

                copied_event['start'] = start_str
                copied_event['end'] = end_str
                # FullCalendar荳翫〒蜷後§ID縺縺ｨ繝舌げ繧句次蝗縺ｫ縺ｪ繧九◆繧√√う繝ｳ繧ｹ繧ｿ繝ｳ繧ｹ蝗ｺ譛峨・謫ｬ莨ｼID・井ｾ・ 10_20260512・峨ｒ莉倅ｸ・
                copied_event['id'] = f"{row['id']}_{current_start.strftime('%Y%m%d')}"
                
                append_calendar_event(events, copied_event)
                
            # 谺｡縺ｮ逋ｺ逕滓律繧定ｨ育ｮ・
            if recurrence_type == 'weekly':
                current_start += timedelta(weeks=1)
            elif recurrence_type == 'monthly':
                # 鄙梧怦縺ｮ蜷後§譌･縺ｫ騾ｲ繧√ｋ・育ｰ｡譏鍋噪縺ｫ30譌･蠕後〒縺ｯ縺ｪ縺乗怦繧貞刈邂暦ｼ・
                year = current_start.year + (current_start.month // 12)
                month = (current_start.month % 12) + 1
                try:
                    current_start = current_start.replace(year=year, month=month)
                except ValueError:
                    # 31譌･縺ｪ縺ｩ縺ｧ鄙梧怦縺ｫ縺昴・譌･縺悟ｭ伜惠縺励↑縺・ｴ蜷医・譛域忰譌･縺ｫ陬懈ｭ｣
                    import calendar as cal_mod
                    _, last_day = cal_mod.monthrange(year, month)
                    current_start = current_start.replace(year=year, month=month, day=last_day)
            elif recurrence_type == 'yearly':
                try:
                    current_start = current_start.replace(year=current_start.year + 1)
                except ValueError:
                    # 縺・ｋ縺・ｹｴ縺ｮ2譛・9譌･蟇ｾ遲・
                    current_start = current_start.replace(year=current_start.year + 1, day=28)
            else:
                break
                
    return jsonify(events)


@app.route('/api/events', methods=['POST'])
def add_event():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    data = request.json

    recurrence = data.get('recurrence', None)
    if recurrence == '':
        recurrence = None

    title = data.get('title')
    start = data.get('start')
    end = data.get('end')
    is_shared = 1 if data.get('is_shared') else 0
    # 繝輔Ο繝ｳ繝医°繧蛾√ｉ繧後ｋ is_all_day 縺ｾ縺溘・ allDay 繧貞ｮ牙・縺ｫ蜿励￠蜿悶ｊ縺ｾ縺・
    is_all_day = 1 if (data.get('is_all_day') or data.get('allDay')) else 0
    label_id = data.get('label_id')
    user_id = session['user_id']
    memo = data.get('memo')

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO events (user_id, title, start_time, end_time, is_shared, is_all_day, label_id, recurrence,memo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (user_id, title, start, end, is_shared, is_all_day, label_id, recurrence,memo))
        conn.commit()
        new_id = cursor.lastrowid
        
    return jsonify({'success': True, 'id': new_id})

@app.route('/api/events/clear', methods=['DELETE'])
def clear_all_events():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    current_user_id = session['user_id']
    
    try:
        with get_db() as conn:
            conn.execute('''
                DELETE FROM events 
                WHERE is_shared = 1 OR user_id = ?
            ''', (current_user_id,))
            conn.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/events/<int:event_id>', methods=['GET', 'PUT', 'DELETE'])
def handle_event(event_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    current_user_id = session['user_id']
    
    with get_db() as conn:
        event = conn.execute('SELECT * FROM events WHERE id = ?', (event_id,)).fetchone()
        if not event:
            return jsonify({'error': 'Not found'}), 404
        
        if event['user_id'] != current_user_id and event['is_shared'] != 1:
            return jsonify({'error': 'Forbidden'}), 403
            
        if request.method == 'PUT':
            data = request.json
            title = data.get('title')
            start = data.get('start')
            end = data.get('end')
            is_shared = 1 if data.get('is_shared') else 0
            # 繝輔Ο繝ｳ繝医°繧蛾√ｉ繧後ｋ is_all_day 縺ｾ縺溘・ allDay 繧貞ｮ牙・縺ｫ蜿励￠蜿悶ｊ縺ｾ縺・
            is_all_day = 1 if (data.get('is_all_day') or data.get('allDay')) else 0
            label_id = data.get('label_id')
            memo = data.get('memo')
            
            recurrence = data.get('recurrence', None)
            if recurrence == '':
                recurrence = None
            
            conn.execute('''
                UPDATE events 
                SET title = ?, start_time = ?, end_time = ?, is_shared = ?, is_all_day = ?, label_id = ?, recurrence = ?,memo=?
                WHERE id = ?
            ''', (title, start, end, is_shared, is_all_day, label_id, recurrence, memo, event_id))
            conn.commit()
            return jsonify({'success': True})

        elif request.method == 'DELETE':
            conn.execute('DELETE FROM events WHERE id = ?', (event_id,))
            conn.commit()
            return jsonify({'success': True})
            
        return jsonify(dict(event))

@app.route('/api/labels', methods=['GET'])
def get_labels():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    current_user_id = session['user_id']
    with get_db() as conn:
        rows = conn.execute('''
            SELECT id, name, color, is_shared, user_id, sort_order FROM labels 
            WHERE is_shared = 1 OR user_id = ?
            ORDER BY is_shared DESC, sort_order ASC, id ASC
        ''', (current_user_id,)).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/labels', methods=['POST'])
def add_event_label_slot_fallback():
    return jsonify({'success': False, 'error': '最大10個の固定ラベル枠仕様のため、新規作成はできません。既存のラベルを編集してください。'})

@app.route('/api/labels/reorder', methods=['PUT'])
def reorder_labels():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    data = request.json or {}
    label_ids = data.get('label_ids') or []
    is_shared = 1 if data.get('is_shared') else 0
    current_user_id = session['user_id']

    if not isinstance(label_ids, list) or not label_ids:
        return jsonify({'error': 'label_ids is required'}), 400

    try:
        label_ids = [int(label_id) for label_id in label_ids]
    except (TypeError, ValueError):
        return jsonify({'error': 'label_ids must be integers'}), 400

    with get_db() as conn:
        placeholders = ','.join(['?'] * len(label_ids))
        if is_shared:
            rows = conn.execute(
                f'SELECT id FROM labels WHERE is_shared = 1 AND id IN ({placeholders})',
                label_ids
            ).fetchall()
            total = conn.execute('SELECT COUNT(*) as cnt FROM labels WHERE is_shared = 1').fetchone()['cnt']
        else:
            rows = conn.execute(
                f'SELECT id FROM labels WHERE is_shared = 0 AND user_id = ? AND id IN ({placeholders})',
                [current_user_id] + label_ids
            ).fetchall()
            total = conn.execute(
                'SELECT COUNT(*) as cnt FROM labels WHERE is_shared = 0 AND user_id = ?',
                (current_user_id,)
            ).fetchone()['cnt']

        found_ids = {row['id'] for row in rows}
        if len(found_ids) != len(label_ids) or len(label_ids) != total:
            return jsonify({'error': 'Invalid label order'}), 400

        for index, label_id in enumerate(label_ids, start=1):
            conn.execute('UPDATE labels SET sort_order = ? WHERE id = ?', (index, label_id))
        conn.commit()

    return jsonify({'success': True})

@app.route('/api/labels/<int:label_id>', methods=['PUT'])
def update_label(label_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    data = request.json
    name = data.get('name')
    color = data.get('color')
    current_user_id = session['user_id']
    
    with get_db() as conn:
        label = conn.execute('SELECT * FROM labels WHERE id = ?', (label_id,)).fetchone()
        if not label:
            return jsonify({'error': 'Not found'}), 404
        if label['is_shared'] == 0 and label['user_id'] != current_user_id:
            return jsonify({'error': 'Forbidden'}), 403
            
        conn.execute('UPDATE labels SET name = ?, color = ? WHERE id = ?', (name, color, label_id))
        conn.commit()
    return jsonify({'success': True})

@app.route('/api/labels/<int:label_id>', methods=['DELETE'])
def delete_label(label_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    current_user_id = session['user_id']
    
    default_colors = [
        '#1aa260', '#e67c73', '#f4511e', '#1a73e8', '#8e24aa',
        '#f6bf26', '#039be5', '#33b679', '#0b8043', '#3f51b5'
    ]
    
    with get_db() as conn:
        label = conn.execute('SELECT * FROM labels WHERE id = ?', (label_id,)).fetchone()
        if not label:
            return jsonify({'error': 'Not found'}), 404
        if label['is_shared'] == 0 and label['user_id'] != current_user_id:
            return jsonify({'error': 'Forbidden'}), 403
            
        if label['is_shared'] == 1:
            siblings = conn.execute(
                'SELECT id FROM labels WHERE is_shared = 1 ORDER BY sort_order ASC, id ASC'
            ).fetchall()
        else:
            siblings = conn.execute(
                'SELECT id FROM labels WHERE user_id = ? AND is_shared = 0 ORDER BY sort_order ASC, id ASC', (current_user_id,)
            ).fetchall()
            
        try:
            slot_num = [s['id'] for s in siblings].index(label_id) + 1
        except ValueError:
            slot_num = 1
                
        reset_name = f'繝ｩ繝吶Ν{slot_num}'
        reset_color = default_colors[(slot_num - 1) % len(default_colors)]
        
        conn.execute('UPDATE labels SET name = ?, color = ? WHERE id = ?', (reset_name, reset_color, label_id))
        conn.commit()
        
    return jsonify({'success': True})

@app.route('/api/holidays', methods=['GET'])
def get_japan_holidays():
    start_param = request.args.get('start')
    end_param = request.args.get('end')
    
    years = [datetime.now().year]
    try:
        if start_param:
            years.append(int(start_param[:4]))
        if end_param:
            years.append(int(end_param[:4]))
            years = list(set(years))
    except (ValueError, TypeError):
        pass
            
    jp_holidays = holidays.Japan(years=years)
    holiday_list = []
    for date, name in jp_holidays.items():
        holiday_list.append({
            'title': name,
            'start': date.strftime('%Y-%m-%d'),
            'display': 'block',
            'color': 'transparent',
            'textColor': '#d93025',
            'className': 'fc-event-holiday',
            'allDay': True,
            'extendedProps': {
                'is_holiday': 1
            }
        })
    return jsonify(holiday_list)


# --- ICSインポート・エクスポート用エンドポイント ---

@app.route('/api/events/export', methods=['GET'])
def export_events_ics():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    current_user_id = session['user_id']
    
    with get_db() as conn:
        rows = conn.execute('''
            SELECT e.id, e.title, e.start_time, e.end_time, e.is_shared, e.is_all_day, e.recurrence, e.memo, l.name as label_name 
            FROM events e
            LEFT JOIN labels l ON e.label_id = l.id
            WHERE e.is_shared = 1 OR e.user_id = ?
        ''', (current_user_id,)).fetchall()

    now = datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//WhiteTree//Calendar//JA',
        'CALSCALE:GREGORIAN'
    ]
    
    for row in rows:
        is_all_day = bool(row['is_all_day'])
        lines.append('BEGIN:VEVENT')
        lines.append(f'UID:whitetree-{row["id"]}@local')
        lines.append(f'DTSTAMP:{now}')
        if is_all_day:
            lines.append(f'DTSTART;VALUE=DATE:{format_ics_datetime(row["start_time"], True)}')
            lines.append(f'DTEND;VALUE=DATE:{format_ics_datetime(row["end_time"], True)}')
        else:
            lines.append(f'DTSTART:{format_ics_datetime(row["start_time"], False)}')
            lines.append(f'DTEND:{format_ics_datetime(row["end_time"], False)}')
        lines.append(fold_ics_line(f'SUMMARY:{escape_ics_text(row["title"])}'))
        if row['label_name']:
            lines.append(fold_ics_line(f'CATEGORIES:{escape_ics_text(row["label_name"])}'))
        if row['memo']:
            lines.append(fold_ics_line(f'DESCRIPTION:{escape_ics_text(row["memo"])}'))
        if row['recurrence']:
            recurrence = row['recurrence'].upper()
            if recurrence in ('WEEKLY', 'MONTHLY', 'YEARLY'):
                lines.append(f'RRULE:FREQ={recurrence}')
        lines.append(f'X-WHITETREE-SCOPE:{"SHARED" if row["is_shared"] else "PRIVATE"}')
        lines.append('END:VEVENT')

    lines.append('END:VCALENDAR')
    output = make_response(('\r\n'.join(lines) + '\r\n').encode('utf-8'))
    output.headers["Content-Disposition"] = "attachment; filename=whitetree-events.ics"
    output.headers["Content-type"] = "text/calendar; charset=utf-8"
    return output

@app.route('/api/events/import', methods=['POST'])
def import_events_ics():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    if 'ics_file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
        
    file = request.files['ics_file']
    if file.filename == '':
        return jsonify({'error': 'No selection'}), 400
        
    try:
        content = file.stream.read().decode('utf-8-sig', errors='ignore')
        content = re.sub(r'\r?\n[ \t]', '', content)
        vevents = re.findall(r'BEGIN:VEVENT(.*?)END:VEVENT', content, re.DOTALL | re.IGNORECASE)
        user_id = session['user_id']
        inserted_count = 0
        
        with get_db() as conn:
            for event_block in vevents:
                fields = {}
                for raw_line in event_block.splitlines():
                    line = raw_line.strip()
                    if ':' not in line:
                        continue
                    key_part, value = line.split(':', 1)
                    key = key_part.split(';', 1)[0].upper()
                    fields[key] = value.strip()

                summary = unescape_ics_text(fields.get('SUMMARY', '')).strip()
                start_time, start_all_day = parse_ics_datetime(fields.get('DTSTART', ''))
                end_time, _ = parse_ics_datetime(fields.get('DTEND', ''))

                if not summary or not start_time:
                    continue

                is_all_day = 1 if start_all_day else 0
                if not end_time:
                    if is_all_day:
                        try:
                            end_time = (datetime.strptime(start_time, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
                        except ValueError:
                            end_time = start_time
                    else:
                        end_time = start_time

                scope = fields.get('X-WHITETREE-SCOPE', '').upper()
                is_shared = 0 if scope == 'PRIVATE' else 1
                categories = unescape_ics_text(fields.get('CATEGORIES', '')).strip()
                memo = unescape_ics_text(fields.get('DESCRIPTION', '')).strip()
                rrule = fields.get('RRULE', '').upper()
                recurrence = None
                if 'FREQ=WEEKLY' in rrule:
                    recurrence = 'weekly'
                elif 'FREQ=MONTHLY' in rrule:
                    recurrence = 'monthly'
                elif 'FREQ=YEARLY' in rrule:
                    recurrence = 'yearly'

                label_id = None
                if categories:
                    lbl = conn.execute('''
                        SELECT id FROM labels 
                        WHERE name = ? AND (is_shared = ? OR user_id = ?)
                    ''', (categories, is_shared, user_id if is_shared == 0 else 0)).fetchone()
                    if lbl:
                        label_id = lbl['id']

                conn.execute('''
                    INSERT INTO events (user_id, title, start_time, end_time, is_shared, is_all_day, label_id, recurrence, memo)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (user_id, summary, start_time, end_time, is_shared, is_all_day, label_id, recurrence, memo))
                inserted_count += 1
            conn.commit()
            
        return jsonify({'success': True, 'count': inserted_count})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    debug_enabled = os.environ.get('FLASK_DEBUG') == '1'
    app.run(host='0.0.0.0', port=5000, debug=debug_enabled)
