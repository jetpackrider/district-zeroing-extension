"""Pinned public input locations and readers for state builds."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
import csv
import fcntl
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import urlsplit
from zipfile import BadZipFile, ZipFile

import numpy as np
from pyogrio.raw import read
import shapely

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
CENSUS = "https://www2.census.gov"
VTD = "https://raw.githubusercontent.com/dra2020/vtd_data/adde69e33112bd2c271cafea1357bacf109a9454"
BLOCK = "https://raw.githubusercontent.com/dra2020/block_data/d0e617bd8607bd40be882c344f7b20500ace993b"
CD119 = CENSUS + "/programs-surveys/decennial/rdo/mapping-files/2025/119-congressional-district-befs/cd119.zip"
STATES = dict(zip(
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(),
    "01 02 04 05 06 08 09 10 11 12 13 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 44 45 46 47 48 49 50 51 53 54 55 56".split(),
    strict=True,
))
BLOCK_GROUP_STATES = {"CA", "HI", "OR", "WV"}
TOTAL = "T_20_CENS_Total"
ADJUSTED = "T_20_CENS_ADJ_Total"


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def check_archive(path, suffix):
    with ZipFile(path) as archive:
        if len([name for name in archive.namelist() if name.lower().endswith(suffix.lower())]) != 1:
            raise BadZipFile(f"{path.name}: expected one {suffix} member")
        error = archive.testzip()
        if error:
            raise BadZipFile(f"{path.name}: CRC failure in {error}")


def download(url, suffix=None):
    CACHE.mkdir(exist_ok=True)
    path = CACHE / urlsplit(url).path.rsplit("/", 1)[1]
    if urlsplit(url).hostname == "data.dra2020.net":
        with (CACHE / ".dra-download.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if path.is_file():
                return path
            lock.seek(0)
            previous = lock.read().strip()
            if previous:
                time.sleep(max(0, 4 - (time.time() - float(previous))))
            try:
                return fetch(url, suffix, path, retries=0)
            finally:
                lock.seek(0)
                lock.truncate()
                lock.write(str(time.time()))
                lock.flush()
    if path.exists():
        return path
    return fetch(url, suffix, path, retries=3)


def fetch(url, suffix, path, retries):
    with tempfile.NamedTemporaryFile(dir=CACHE, delete=False) as temp:
        partial = Path(temp.name)
    try:
        # The URLs are fixed to public source hosts. Do not follow redirects.
        print(f"Downloading {path.name}", flush=True)
        subprocess.run(["curl", "--fail", "--silent", "--show-error", "--retry", str(retries),
                        "--connect-timeout", "15", "--speed-limit", "1024", "--speed-time", "30",
                        "--output", str(partial), url], check=True)
        if suffix:
            check_archive(partial, suffix)
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)
    return path


def block_catalog_url(state, version):
    name = f"Demographic_Data_Block_{state}.{version}"
    return f"{BLOCK}/2020_Geography/{state}/{name}.md"


def block_zip_url(catalog, state, version):
    name = f"Demographic_Data_Block_{state}.{version}"
    expected = f"https://data.dra2020.net/file/dra-block-data/{name}.zip"
    links = re.findall(r"\]\((https://data\.dra2020\.net/[^)]+)\)", catalog)
    if catalog.splitlines()[0] != f"## {name}" or links != [expected]:
        raise ValueError(f"Unexpected DRA catalog entry for {name}")
    return links[0]


def get_inputs(state, version, local_blocks):
    fips = STATES[state]
    folder = f"{VTD}/2020_VTD/{state}"
    sources = {
        "tiger": (f"{CENSUS}/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_{fips}_tabblock20.zip",
                  f"tl_2020_{fips}_tabblock20.shp"),
        "precincts": (f"{folder}/Demographic_Data_{state}.{version}.zip", ".csv"),
        "graph": (f"{folder}/Geojson_{state}.{version}.zip", "_graph.json"),
        "blockCatalog": (block_catalog_url(state, version), None),
        "fixture": (CD119, "NationalCD119.txt"),
    }
    if state not in BLOCK_GROUP_STATES:
        sources["baf"] = (f"{CENSUS}/geo/docs/maps-data/data/baf2020/BlockAssign_ST{fips}_{state}.zip", "_VTD.txt")
    if state == "FL":
        sources["precinctShapes"] = (f"{folder}/Geojson_FL.v07.zip", ".geojson")
    CACHE.mkdir(exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as executor:
        tasks = {key: executor.submit(download, *source) for key, source in sources.items()}
        paths = {key: task.result() for key, task in tasks.items()}
    catalog = paths["blockCatalog"].read_text(encoding="utf-8")
    block_url = block_zip_url(catalog, state, version)
    provenance = {key: {"url": sources[key][0], "sha256": sha256(path)}
                  for key, path in paths.items()}
    if local_blocks:
        paths["blocks"] = local_blocks
        provenance["blocks"] = {"file": local_blocks.name, "sha256": sha256(local_blocks)}
    else:
        paths["blocks"] = download(block_url, ".csv")
        provenance["blocks"] = {"url": block_url, "sha256": sha256(paths["blocks"])}
    return paths, provenance


@contextmanager
def member(path, suffix):
    with ZipFile(path) as archive:
        name, = [name for name in archive.namelist() if name.lower().endswith(suffix.lower())]
        with archive.open(name) as stream:
            yield stream


@contextmanager
def records(path, suffix=".csv", delimiter=","):
    if path.suffix.lower() == ".zip":
        with member(path, suffix) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as stream:
            yield csv.DictReader(stream, delimiter=delimiter)
    else:
        with path.open(encoding="utf-8-sig", newline="") as stream:
            yield csv.DictReader(stream, delimiter=delimiter)


def unique_rows(rows):
    result = {}
    for key, value in rows:
        if key in result:
            raise ValueError(f"Duplicate GEOID {key}")
        result[key] = value
    return result


@contextmanager
def csv_stream(path):
    if path.suffix.lower() == ".zip":
        with member(path, ".csv") as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as stream:
            yield stream
    else:
        with path.open(encoding="utf-8-sig", newline="") as stream:
            yield stream


def populations(path):
    with csv_stream(path) as stream:
        rows = csv.reader(stream)
        header = next(rows)
        has_adjusted = ADJUSTED in header
        key = header.index("GEOID20" if "GEOID20" in header else "GEOID")
        total = header.index(TOTAL)
        adjusted = header.index(ADJUSTED) if has_adjusted else total
        result = unique_rows((r[key], (int(r[total]), int(r[adjusted]))) for r in rows if r)
    return result, has_adjusted


def tiger_land(path):
    """Block IDs (sorted) and ALAND20 only: no geometry, so it is fast enough to run for every state."""
    _, _, _, values = read(f"zip://{path}", columns=["GEOID20", "ALAND20"], read_geometry=False)
    ids = np.asarray(values[0], dtype=str)
    order = np.argsort(ids)
    return ids[order].tolist(), np.asarray(values[1])[order]


def tiger_blocks(path, fips):
    meta, _, wkb, values = read(f"zip://{path}", columns=["GEOID20", "POP20", "ALAND20"])
    columns = dict(zip(meta["fields"], values, strict=True))
    order = np.argsort(columns["GEOID20"])
    ids = columns["GEOID20"][order].tolist()
    if (any(len(key) != 15 or not key.isascii() or not key.isdecimal() or not key.startswith(fips) for key in ids)
            or len(set(ids)) != len(ids)):
        raise ValueError("Invalid or duplicate TIGER block GEOID")
    shapes = shapely.from_wkb(wkb[order])
    if np.any(shapely.is_empty(shapes)) or np.any(shapely.is_missing(shapes)):
        raise ValueError("Empty TIGER block geometry")
    return ids, columns["POP20"][order], columns["ALAND20"][order], shapes, meta["crs"]


def precinct_membership(state, paths, ids):
    if state in BLOCK_GROUP_STATES:
        return [key[:12] for key in ids], {"blockGroupBlocks": len(ids)}
    subdivisions = {}
    if state == "ME":
        with records(paths["baf"], "_MCD.txt", "|") as rows:
            subdivisions = unique_rows((r["BLOCKID"], STATES[state] + r["COUNTYFP"] + r["COUSUBFP"])
                                        for r in rows)
    with records(paths["baf"], "_VTD.txt", "|") as rows:
        baf = unique_rows((r["BLOCKID"], STATES[state] + r["COUNTYFP"] + r["DISTRICT"] if r["DISTRICT"]
                           else subdivisions.get(r["BLOCKID"], "OUT_OF_STATE")) for r in rows)
    missing, extra = sorted(set(ids) - baf.keys()), sorted(baf.keys() - set(ids))
    if missing or extra:
        raise ValueError(f"BAF vs TIGER: missing={len(missing)} {missing[:5]}, extra={len(extra)} {extra[:5]}")
    membership = [baf[key] for key in ids]
    kinds = {"vtdBlocks": sum(len(key) == 11 for key in membership),
             "unassignedBlocks": membership.count("OUT_OF_STATE")}
    if state == "ME":
        kinds["countySubdivisionBlocks"] = sum(len(key) == 10 for key in membership)
        kinds["countySubdivisionPrecincts"] = len({key for key in membership if len(key) == 10})
    return membership, kinds


def reference_graph(path):
    with member(path, "_graph.json") as stream:
        graph = json.load(stream)
    if any(len(neighbors) != len(set(neighbors)) or a in neighbors
           or any(a not in graph.get(b, ()) for b in neighbors)
           for a, neighbors in graph.items()):
        raise ValueError("DRA reference graph has duplicate, self or asymmetric edges")
    return set(graph), {(a, b) for a, neighbors in graph.items() for b in neighbors if a < b}


def fixture_text(path, state, digest, ids):
    fips = STATES[state]
    suffix = f"{fips}_{state}_CD119.txt"
    with ZipFile(path) as archive:
        has_state_file = suffix in archive.namelist()
    if not has_state_file:
        path = national_cd119(path, digest) / f"{fips}.csv"
    with records(path, suffix) as rows:
        assignment = unique_rows((r["GEOID"], None if r["CDFP"] == "ZZ" else int(r["CDFP"]))
                                 for r in rows)
    districts = set(assignment.values()) - {None}
    missing, extra = sorted(set(ids) - assignment.keys()), sorted(assignment.keys() - set(ids))
    if missing or extra or not districts or len(districts) > 1 and districts != set(range(1, max(districts) + 1)):
        raise ValueError(f"{state} CD119 BEF: missing={len(missing)} {missing[:8]}, "
                         f"extra={len(extra)} {extra[:8]}, district labels={sorted(districts)}")
    unassigned = [i for i, key in enumerate(ids) if assignment[key] is None]
    if len(districts) == 1:
        return None, 1, unassigned
    text = "GEOID20,District\n" + "".join(f"{key},{assignment[key]}\n" for key in ids
                                          if assignment[key] is not None)
    return text, len(districts), unassigned


def national_cd119(path, digest):
    directory = CACHE / f"cd119-{digest}"
    if directory.is_dir():
        return directory
    with tempfile.TemporaryDirectory(dir=CACHE) as temp:
        split = Path(temp) / "cd119"
        split.mkdir()
        with records(path, "NationalCD119.txt") as rows, ExitStack() as stack:
            outputs = {fips: stack.enter_context((split / f"{fips}.csv").open("w", encoding="utf-8"))
                       for fips in STATES.values()}
            for stream in outputs.values():
                stream.write("GEOID,CDFP\n")
            for row in rows:
                geoid = row["GEOID"]
                if geoid[:2] in outputs:
                    outputs[geoid[:2]].write(f"{geoid},{row['CDFP']}\n")
        try:
            split.rename(directory)
        except OSError:
            if not directory.is_dir():
                raise
    return directory
