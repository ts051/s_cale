import os
import re
from datetime import datetime
import pandas as pd

def parse_ics_file(file_path):
    """単一のicsファイルからイベント情報を抽出する関数"""
    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()

    # VEVENT（予定）ブロックをすべて抽出
    vevents = re.findall(r'BEGIN:VEVENT(.*?)END:VEVENT', content, re.DOTALL)
    
    events_list = []
    file_name = os.path.basename(file_path)
    
    for event in vevents:
        event_data = {}
        
        # ファイル名を記録
        event_data['SOURCE_FILE'] = file_name
        
        # 1. SUMMARY (予定のタイトル)
        summary_match = re.search(r'SUMMARY:(.*)', event)
        event_data['SUMMARY'] = summary_match.group(1).strip() if summary_match else ''
        
        # 2. DTSTART (開始日時) -> 日付と時間に分解
        dtstart_match = re.search(r'DTSTART[;:][^:]*:(.*)', event)
        if dtstart_match:
            raw_start = dtstart_match.group(1).strip()
            try:
                dt = datetime.strptime(raw_start[:15], '%Y%m%dT%H%M%S')
                event_data['START_DATE'] = dt.strftime('%Y-%m-%d')
                event_data['START_TIME'] = dt.strftime('%H:%M:%S')
            except ValueError:
                event_data['START_DATE'] = raw_start
                event_data['START_TIME'] = ''
        else:
            event_data['START_DATE'] = ''
            event_data['START_TIME'] = ''
            
        # 3. DTEND (終了日時) -> 日付と時間に分解
        dtend_match = re.search(r'DTEND[;:][^:]*:(.*)', event)
        if dtend_match:
            raw_end = dtend_match.group(1).strip()
            try:
                dt = datetime.strptime(raw_end[:15], '%Y%m%dT%H%M%S')
                event_data['END_DATE'] = dt.strftime('%Y-%m-%d')
                event_data['END_TIME'] = dt.strftime('%H:%M:%S')
            except ValueError:
                event_data['END_DATE'] = raw_end
                event_data['END_TIME'] = ''
        else:
            event_data['END_DATE'] = ''
            event_data['END_TIME'] = ''
            
        # 4. CATEGORIES (カテゴリー)
        cat_match = re.search(r'CATEGORIES:(.*)', event)
        event_data['CATEGORIES'] = cat_match.group(1).strip() if cat_match else ''
        
        # 5. DESCRIPTION (詳細説明)
        desc_match = re.search(r'DESCRIPTION:(.*)', event)
        event_data['DESCRIPTION'] = desc_match.group(1).strip() if desc_match else ''
        
        # 6. LOCATION (場所)
        loc_match = re.search(r'LOCATION:(.*)', event)
        event_data['LOCATION'] = loc_match.group(1).strip() if loc_match else ''

        events_list.append(event_data)
        
    return events_list

def convert_folder_ics_to_csv(folder_path, output_csv_name='combined_calendar.csv'):
    """フォルダ内の全てのicsファイルを解析し、1つのCSVに出力する関数"""
    all_events = []
    
    # フォルダ内のファイルを走査
    if not os.path.exists(folder_path):
        print(f"エラー: 指定されたフォルダ '{folder_path}' が見つかりません。")
        return

    for file in os.listdir(folder_path):
        if file.lower().endswith('.ics'):
            file_path = os.path.join(folder_path, file)
            print(f"解析中: {file}")
            file_events = parse_ics_file(file_path)
            all_events.extend(file_events)
            
    if not all_events:
        print("対象の .ics ファイル、または予定データが見つかりませんでした。")
        return

    # DataFrameに変換
    df = pd.DataFrame(all_events)
    
    # 開始日（START_DATE）と開始時間（START_TIME）で昇順に並び替え
    sort_columns = []
    if 'START_DATE' in df.columns:
        sort_columns.append('START_DATE')
    if 'START_TIME' in df.columns:
        sort_columns.append('START_TIME')
        
    if sort_columns:
        df = df.sort_values(by=sort_columns).reset_index(drop=True)
        
    # 列の順番をきれいに並び替え
    columns_order = [
        'START_DATE', 'START_TIME', 
        'END_DATE', 'END_TIME', 
        'SUMMARY', 'CATEGORIES', 'LOCATION', 'DESCRIPTION', 'SOURCE_FILE'
    ]
    df = df[columns_order]

    # Excelでの文字化けを防ぐため、BOM付きUTF-8 (utf-8-sig) で保存
    df.to_csv(output_csv_name, index=False, encoding='utf-8-sig')
    print(f"\n変換完了！ => {output_csv_name} (合計 {len(df)} 件の予定)")

# --- 実行部分 ---
if __name__ == '__main__':
    # 対象のicsファイルが入っているフォルダのパスを指定してください
    target_folder = './calendar_files' 
    
    # 出力するCSVファイル名
    output_csv = 'merged_calendar_data.csv'
    
    # 変換処理の実行
    convert_folder_ics_to_csv(target_folder, output_csv)