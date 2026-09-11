"""Read-only 2Y Excel cache extraction. Private audit MUST be outside this repo.

The reviewed slide date is explicit: a filename or modification date is not evidence.
Only the v2 deck's named visible labels and new single-series charts are eligible.
Its legacy six-series hidden chart caches are deliberately excluded.
"""
import argparse
import hashlib
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from rv_data import SECTIONS, METRICS, FIELDS, choose, validate, valid
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
      'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
      'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart'}

def col(n):
    out = ''
    while n:
        n, rem = divmod(n - 1, 26)
        out = chr(65 + rem) + out
    return out

def cell_number(cell):
    if cell is None or cell.get('t', 'n') != 'n':
        return None
    try:
        value = float(cell.find('m:v', NS).text)
        return value if valid(value, 'current') else None
    except (AttributeError, TypeError, ValueError):
        return None

def sheet(z, number):
    return {c.get('r'): c for c in ET.fromstring(z.read(f'xl/worksheets/sheet{number}.xml')).findall('.//m:c', NS)}

def slide_values(z, page, count):
    tree = ET.fromstring(z.read(f'ppt/slides/slide{page}.xml'))
    result = [{} for _ in range(count)]
    for shape in tree.findall('.//p:sp', NS):
        meta = shape.find('p:nvSpPr/p:cNvPr', NS)
        name = meta.get('name', '') if meta is not None else ''
        for field in ('min', 'max', 'current'):
            if name.startswith(f'value-{field}-'):
                i = int(name.rsplit('-', 1)[1])
                text = ''.join(t.text or '' for t in shape.findall('.//a:t', NS))
                result[i][field] = (float(text), name, 'rounded integer bp')
    # Only chart referenced by the new percentile graphic is used. Old combo caches are stale.
    chart = ET.fromstring(z.read(f'ppt/slides/charts/chart{(page-1)*2}.xml'))
    series = chart.findall('.//c:ser', NS)
    if len(series) != 1:
        raise ValueError('Expected reviewed single-series percentile chart')
    for point in series[0].findall('./c:val//c:pt', NS):
        result[int(point.get('idx'))]['pct'] = (float(point.find('c:v', NS).text), f'chart{(page-1)*2}/point{point.get("idx")}', 'native numeric cache')
    return result

def extract(files, deck, date, slide_date):
    data = {'date': date, 'horizon': '2Y', 'sections': {s: {} for s in SECTIONS}}
    audit = {'date': date, 'slide_date_attestation': slide_date, 'deck': str(deck), 'deck_sha256': hashlib.sha256(deck.read_bytes()).hexdigest(), 'workbooks': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}, 'values': [], 'differences': []}
    with zipfile.ZipFile(deck) as ppt:
        for mi, (metric, path) in enumerate(zip(METRICS, files)):
            with zipfile.ZipFile(path) as book:
                strings = [''.join(t.itertext()) for t in ET.fromstring(book.read('xl/sharedStrings.xml'))]
                for si, (section, categories) in enumerate(SECTIONS.items()):
                    cells = sheet(book, 2 + si*2)
                    history = sheet(book, 1 + si*2)
                    page = 2 + si*4 + mi
                    fallback = slide_values(ppt, page, len(categories))
                    records = []
                    for i, category in enumerate(categories):
                        header = cells.get(f'{col(5+i)}4')
                        actual = strings[int(header.find('m:v', NS).text)]
                        aliases = {'Ins': 'Insurance', 'Chem': 'Chemical', 'HC': 'Healthcare', 'Trans': 'Transportation'}
                        if aliases.get(actual, actual) != category:
                            raise ValueError(f'Unexpected category {actual!r}, expected {category}')
                        serial = cell_number(history.get(f'{col(1+i*4)}8'))
                        excel_date = (datetime(1899,12,30)+timedelta(days=serial)).date().isoformat() if serial is not None else None
                        record = {'sector': category, 'sources': {}}
                        for field, row in zip(FIELDS, [5,7,9,11,6]):
                            address = f'{col(([16,18,17][si] if field == "pct" else 5)+i)}{row}'
                            raw = cell_number(cells.get(address))
                            backup, locator, precision = fallback[i].get(field, (None, None, None))
                            value, source = choose(raw, backup, field, date, excel_date, slide_date)
                            record[field], record['sources'][field] = value, source
                            item = {'section': section, 'metric': metric, 'sector': category, 'field': field, 'value': value, 'source': source, 'file': str(path), 'sheet': section, 'cell': address, 'excel_date': excel_date, 'slide': page, 'slide_locator': locator, 'slide_value': backup, 'precision': 'full numeric cache' if source == 'Excel' else precision}
                            audit['values'].append(item)
                            if raw is not None and backup is not None:
                                tolerance = 0.500000001 if field != 'pct' else 1e-12
                                if abs(raw-backup) > tolerance:
                                    audit['differences'].append(item)
                        # Invalid ordered summaries cannot be published as valid Excel data.
                        if all(record[f] is not None for f in ('min','median','max')) and not record['min'] <= record['median'] <= record['max']:
                            for field in ('min','median','max'):
                                backup = fallback[i].get(field, (None,))[0]
                                record[field], record['sources'][field] = choose(None, backup, field, date, None, slide_date)
                                item = next(x for x in reversed(audit['values']) if x['field'] == field)
                                item.update(value=record[field], source=record['sources'][field], precision='rounded integer bp' if backup is not None else None, reason='invalid Excel ordering')
                        records.append(record)
                    data['sections'][section][metric] = records
    validate(data)
    return data, audit

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--workbooks', nargs=4, required=True, metavar='PATH', help='Spread, 10Y, 30Y, 10s30s, in order')
    for name in ('deck','date','slide-date','audit'):
        p.add_argument('--'+name, required=True)
    args = p.parse_args()
    audit_path = Path(args.audit).resolve()
    if audit_path.is_relative_to(ROOT):
        p.error('Private audit must be outside the repository')
    data, audit = extract([Path(p) for p in args.workbooks], Path(args.deck), args.date, args.slide_date)
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
    if audit['differences']:
        raise ValueError(f'{len(audit["differences"])} slide differences require review; snapshot not replaced')
    (ROOT/'assets/rv-data.json').write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    print(f'{len(audit["values"])} summary values extracted; {sum(v["value"] is None for v in audit["values"])} missing; differences=0')

if __name__ == '__main__':
    main()
