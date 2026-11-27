"""显式下载 Petdex 安装量前 50；只处理数据资源，不运行下载包里的程序。"""
from pathlib import Path, PurePosixPath
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import urllib.request
import zipfile
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / 'desktop/assets/mascots'
CACHE = ROOT / '.verify/petdex-downloads'
SOURCE = 'https://petdex.dev/api/pets/search?sort=installed&limit=50&includeMeta=0'
HEADERS = {'User-Agent': 'Mozilla/5.0 OwnerCompanion asset import', 'Referer': 'https://petdex.dev/zh'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def get(url, maximum=32 * 1024 * 1024):
    if not url.startswith(('https://petdex.dev/', 'https://assets.petdex.dev/')):
        raise ValueError('资源必须来自 Petdex 官方域名')
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=50) as response:
        if not response.url.startswith(('https://petdex.dev/', 'https://assets.petdex.dev/')):
            raise ValueError('不接受跨站重定向')
        data = response.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError('资源超过下载上限')
        return data


def prepare(rank, pet, stage, stamp):
    slug = pet['slug']
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', slug):
        raise ValueError('非法来源标识')
    url = pet.get('zipUrl')
    if not url:
        raise ValueError(f'{slug} 没有公开下载包')
    cache = CACHE / (slug + '-' + digest(url.encode())[:12] + '.zip')
    data = cache.read_bytes() if cache.exists() else get(url)
    if not cache.exists():
        cache.write_bytes(data)
    archive = zipfile.ZipFile(io.BytesIO(data))
    files = [item for item in archive.infolist() if not item.is_dir()]
    if len(files) > 100 or sum(item.file_size for item in files) > 64 * 1024 * 1024:
        raise ValueError(f'{slug} 解压体积异常')
    for item in files:
        name = PurePosixPath(item.filename)
        if name.is_absolute() or '..' in name.parts or '\\' in item.filename or (item.external_attr >> 16) & 0o170000 == 0o120000:
            raise ValueError(f'{slug} 含不安全归档路径')
    manifests = [item for item in files if PurePosixPath(item.filename).name == 'pet.json']
    if len(manifests) != 1:
        raise ValueError(f'{slug} 必须只有一份 pet.json')
    original = archive.read(manifests[0])
    meta = json.loads(original)
    source_name = meta.get('spritesheetPath') or meta.get('spritesheet') or meta.get('file')
    relative = PurePosixPath(str(source_name))
    if relative.is_absolute() or '..' in relative.parts or '\\' in str(source_name):
        raise ValueError(f'{slug} 精灵图路径非法')
    sheet_path = str(PurePosixPath(manifests[0].filename).parent / relative)
    repairs = []
    if sheet_path not in archive.namelist():
        candidates = [item.filename for item in files
                      if PurePosixPath(item.filename).stem == relative.stem
                      and PurePosixPath(item.filename).suffix.lower() in ['.png', '.webp', '.gif']]
        if len(candidates) != 1:
            raise ValueError(f'{slug} 的精灵图引用无效且不能唯一定位')
        repairs.append(f'Archive filename correction: {sheet_path} -> {candidates[0]}')
        sheet_path = candidates[0]
        relative = PurePosixPath(sheet_path)
    sheet = archive.read(sheet_path)
    extension = relative.suffix.lower()
    if extension not in ['.png', '.webp', '.gif']:
        raise ValueError(f'{slug} 不是支持的精灵图格式')
    image = Image.open(io.BytesIO(sheet)).convert('RGBA')
    version = int(meta.get('spriteVersionNumber') or meta.get('version') or 1)
    columns = int(meta.get('columns') or 8)
    rows = int(meta.get('rows') or (11 if version >= 2 else 9))
    if not 1 <= columns <= 32 or not 1 <= rows <= 32 or image.width % columns or image.height % rows:
        raise ValueError(f'{slug} 图集尺寸与动作网格不匹配: {image.size}, {columns}x{rows}')
    width, height = image.width // columns, image.height // rows
    identity = (f'petdex-{rank:02d}-' + slug)[:40].rstrip('-')
    folder = stage / identity
    folder.mkdir()
    (folder / 'upstream-pet.json').write_bytes(original)
    sheet_name = 'spritesheet' + extension
    (folder / sheet_name).write_bytes(sheet)
    meta.update({'id': identity, 'displayName': pet.get('displayName') or meta.get('displayName') or slug,
                 'spritesheetPath': sheet_name, 'frameWidth': width, 'frameHeight': height,
                 'columns': columns, 'rows': rows, 'collection': 'petdex', 'rank': rank})
    (folder / 'pet.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n')
    # 首帧只作轻量缩略图；原始精灵图逐字节保留，运行时不解码 50 张大图作为卡片封面。
    row = int(meta.get('states', {}).get('idle', {}).get('row', 0))
    thumbnail = image.crop((0, row * height, width, (row + 1) * height))
    thumbnail.thumbnail((128, 128), Image.Resampling.LANCZOS)
    thumbnail.save(folder / 'thumb.png')
    notices = []
    for item in files:
        name = PurePosixPath(item.filename).name
        if re.match(r'^(license|copying|notice|credits|readme)', name, re.I) and Path(name).suffix.lower() in ['', '.md', '.txt']:
            if name.lower() not in [p.lower() for p in notices]:
                (folder / name).write_bytes(archive.read(item))
                notices.append(name)
    provenance = {'rank': rank, 'id': identity, 'slug': slug, 'displayName': meta['displayName'],
                  'source': 'https://petdex.dev/pets/' + slug, 'zipUrl': url,
                  'author': pet.get('submittedBy', {}).get('name'), 'metrics': pet.get('metrics', {}),
                  'spriteVersionNumber': version, 'downloadedAt': stamp, 'archiveSha256': digest(data),
                  'license': pet.get('license'), 'licenseFiles': notices, 'adaptations': repairs}
    (folder / 'source.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n')
    provenance['files'] = [{'path': p.name, 'sha256': digest(p.read_bytes()), 'bytes': p.stat().st_size}
                           for p in sorted(folder.iterdir()) if p.is_file()]
    return provenance


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    if (TARGET / 'petdex-manifest.json').exists():
        raise SystemExit('已存在 Petdex 快照。请先审阅旧清单，再显式更新；不自动覆盖仓库资源。')
    raw = get(SOURCE, 4 * 1024 * 1024)
    data = json.loads(raw)
    pets = data.get('pets', [])
    if len(pets) != 50 or len({p['slug'] for p in pets}) != 50:
        raise ValueError('排行未返回完整且不重复的 50 项')
    counts = [p.get('metrics', {}).get('installCount', 0) for p in pets]
    if counts != sorted(counts, reverse=True):
        raise ValueError('安装量排序不是降序，不能当作前 50 项')
    stamp = datetime.now(timezone.utc).isoformat()
    stage = Path(tempfile.mkdtemp(prefix='petdex-import-', dir=ROOT / '.verify'))
    records = []
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(prepare, index + 1, pet, stage, stamp): pet['slug'] for index, pet in enumerate(pets)}
            for future in as_completed(futures):
                record = future.result()
                records.append(record)
                print(f"Downloaded {len(records):02d}/50: #{record['rank']:02d} {record['slug']}", flush=True)
        records.sort(key=lambda item: item['rank'])
        for record in records:
            if (TARGET / record['id']).exists():
                raise ValueError('目标目录已经存在，未覆盖')
        for record in records:
            shutil.move(str(stage / record['id']), TARGET / record['id'])
        manifest = {'schemaVersion': 1, 'sourcePage': 'https://petdex.dev/zh', 'api': SOURCE,
                    'sort': 'installed', 'sortLabel': 'Most installed', 'snapshotAt': stamp,
                    'count': 50, 'listingSha256': digest(raw), 'pets': records,
                    'licenseNote': '按条目保留来源、作者与包内声明；未声明许可的条目不推定为 MIT 或其他开源许可。'}
        (TARGET / 'petdex-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        total = sum(f['bytes'] for record in records for f in record['files'])
        print(f'Imported 50 packages, {total / 1024 / 1024:.1f} MiB. Default: {records[0]["id"]}', flush=True)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == '__main__':
    main()
