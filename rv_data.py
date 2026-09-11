"""RV snapshot validation shared by extraction, builds and tests (stdlib only)."""
import math

SECTIONS = {
    'Overview': ['JULI', 'Fin', 'Non-Fin', 'AA', 'A', 'BBB'],
    'Cyclical': ['US Bank', 'Yankee Bank', 'Insurance', 'M&M', 'Chemical', 'Tech', 'Auto', 'Media', 'Energy', 'Capital Good'],
    'Non-Cyclical': ['Telecom', 'Utility', 'F&B', 'Tobacco', 'Healthcare', 'Retail', 'Transportation'],
}
METRICS = ['Spread', '10Y', '30Y', '10s30s']
FIELDS = ['min', 'median', 'max', 'current', 'pct']

def valid(value, field):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value) and (field != 'pct' or 0 <= value <= 1)

def choose(excel, fallback, field, date, excel_date, slide_date):
    if excel_date == date and valid(excel, field):
        return excel, 'Excel'
    if slide_date == date and valid(fallback, field):
        return fallback, '投影片'
    return None, '缺值'

def validate(data):
    from datetime import date
    date.fromisoformat(data['date'])
    if set(data) != {'date', 'horizon', 'sections'} or data['horizon'] != '2Y':
        raise ValueError('Unexpected snapshot metadata')
    if list(data['sections']) != list(SECTIONS):
        raise ValueError('Section coverage/order mismatch')
    for section, sectors in SECTIONS.items():
        if list(data['sections'][section]) != METRICS:
            raise ValueError('Metric coverage/order mismatch')
        for metric, records in data['sections'][section].items():
            if [r['sector'] for r in records] != sectors:
                raise ValueError(f'Sector order mismatch: {section}/{metric}')
            for r in records:
                if set(r) != {'sector', 'sources', *FIELDS} or set(r['sources']) != set(FIELDS):
                    raise ValueError('Unexpected record fields')
                for field in FIELDS:
                    if r[field] is not None and not valid(r[field], field):
                        raise ValueError(f'Invalid {field}')
                    if r['sources'][field] not in ('Excel', '投影片', '缺值'):
                        raise ValueError('Invalid source type')
                    if (r[field] is None) != (r['sources'][field] == '缺值'):
                        raise ValueError('Missing source mismatch')
                vals = [r[f] for f in ('min', 'median', 'max')]
                known = [v for v in vals if v is not None]
                if known != sorted(known):
                    raise ValueError('Min ≤ Median ≤ Max failed')
