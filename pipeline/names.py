"""Build and validate county and town labels in bundle index order."""
import json

from format import atomic_write, file_matches, packed_file, publish
from inputs import ROOT, STATES
from towns import bundle_block_order, gazetteer, town_file, validate_towns


def names_file(county_fips, town_names, town_count):
    counties, _ = gazetteer("counties")
    county_names = [counties[fips][1] for fips in county_fips]
    if (len(town_names) != town_count + 1 or town_names[0] != ""
            or not all(county_names) or not all(town_names[1:])):
        raise ValueError("Invalid county or town names")
    data = dict(counties=county_names, towns=town_names)
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return packed_file("names.{hash}.json.gz", raw)


def validate_names(directory, manifest, ref):
    if manifest.get("names") != ref or not file_matches(directory / ref["file"], ref):
        raise ValueError("Names sidecar is missing or differs (run: build.py names STATE)")


def names_for_bundle(state, validate):
    directory = ROOT.parent / "data" / state
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    if manifest["state"] != state or manifest["stateFips"] != STATES[state] or manifest["format"] != 1:
        raise ValueError(f"Invalid {state} manifest")
    ids, county_fips = bundle_block_order(directory, manifest)
    if county_fips != [county["fips"] for county in manifest["counties"]]:
        raise ValueError("Attributes and manifest counties disagree")
    towns, _, sources, _, town_names = town_file(state, ids)
    validate_towns(directory, manifest, towns, sources)
    ref, packed = names_file(county_fips, town_names, towns["count"])
    if validate:
        validate_names(directory, manifest, ref)
    else:
        publish(directory, ref, packed)
        # Refresh after recomputing the source data so any newly installed sidecars are kept.
        current = json.loads(manifest_path.read_bytes())
        if any(current.get(key) != manifest.get(key) for key in ("attrs", "towns", "counties")):
            raise ValueError("Bundle changed while generating names (run: build.py names STATE)")
        if current.get("names") != ref:
            current["names"] = ref
            atomic_write(manifest_path, (json.dumps(current, indent=2) + "\n").encode())
    verb = "validated" if validate else "wrote"
    print(f"{state}: {verb} {len(county_fips)} county and {towns['count']} town names "
          f"({ref['bytes']} compressed bytes)", flush=True)
