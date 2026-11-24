"""Hash projected endpoints, then group undirected segment keys."""
import numpy as np
import shapely
from pyproj import Transformer


def project(geometry, crs):
    transformer = Transformer.from_crs(crs, 5070, always_xy=True)
    projected = np.empty_like(geometry)
    for start in range(0, len(geometry), 32768):
        chunk = slice(start, start + 32768)
        projected[chunk] = shapely.transform(geometry[chunk], transformer.transform, interleaved=False)
    return projected


def rook(geometry):
    """Original New York aggregation, retained for byte-for-byte validation."""
    origin = np.rint(shapely.total_bounds(geometry)[:2] * 1000).astype(np.int64)
    low, high, owner, lengths = segments(geometry, origin, 32)
    a, b, left, right, exterior = shared_segments(low, high, owner)
    edges = sum_edges(a, b, lengths[left])
    outer = np.bincount(owner[exterior], weights=lengths[exterior], minlength=len(geometry))
    return edges, outer


def segments(geometry, origin, y_bits, offset=0):
    polygons, block = shapely.get_parts(geometry, return_index=True)
    rings, polygon = shapely.get_rings(polygons, return_index=True)
    del polygons
    coordinates, ring = shapely.get_coordinates(rings, return_index=True)
    # Pack millimeter coordinates into a single sortable endpoint key.
    xy = np.rint(coordinates * 1000).astype(np.int64)
    xy -= origin
    keys = (xy[:, 0].astype(np.uint64) << y_bits) | xy[:, 1].astype(np.uint64)
    del xy
    contiguous = (ring[:-1] == ring[1:]) & (keys[:-1] != keys[1:])
    starts = keys[:-1][contiguous]
    ends = keys[1:][contiguous]
    owner = block[polygon[ring[:-1][contiguous]]].astype(np.uint32) + offset
    lengths = np.linalg.norm((coordinates[1:] - coordinates[:-1])[contiguous], axis=1)
    del coordinates, ring, keys
    low, high = np.minimum(starts, ends), np.maximum(starts, ends)
    del starts, ends
    order = np.lexsort((high, low))
    return low[order], high[order], owner[order], lengths[order]


def shared_segments(low, high, owner):
    equal = (low[:-1] == low[1:]) & (high[:-1] == high[1:])
    if (equal[:-1] & equal[1:]).any():
        raise ValueError("More than two occurrences of a segment")
    shared = equal & (owner[:-1] != owner[1:])
    left = np.flatnonzero(shared)
    right = left + 1
    exterior = np.ones(len(owner), dtype=bool)
    exterior[:-1] &= ~shared
    exterior[1:] &= ~shared
    return owner[left], owner[right], left, right, exterior


def sum_edges(a, b, lengths):
    edge = (np.minimum(a, b).astype(np.uint64) << 32) | np.maximum(a, b)
    unique, reverse = np.unique(edge, return_inverse=True)
    shared_lengths = np.bincount(reverse, weights=lengths)
    return dict(zip(zip((unique >> 32).tolist(), (unique & 0xffffffff).tolist()), shared_lengths))


def rook_partitioned(geometry, county_of):
    """Hash small contiguous county batches, then reconcile their unpaired segments."""
    bounds = np.rint(shapely.total_bounds(geometry) * 1000).astype(np.int64)
    y_bits = max(1, int(bounds[3] - bounds[1]).bit_length())
    if int(bounds[2] - bounds[0]).bit_length() + y_bits > 64:
        raise ValueError("Projected state span exceeds the 64-bit endpoint encoding")
    stops = np.r_[0, np.flatnonzero(county_of[1:] != county_of[:-1]) + 1, len(geometry)]
    pending = []
    edges = {}
    for first, stop in zip(stops[:-1], stops[1:], strict=True):
        for start in range(first, stop, 32768):
            low, high, owner, lengths = segments(
                geometry[start:min(start + 32768, stop)], bounds[:2], y_bits, int(start))
            a, b, left, _, exterior = shared_segments(low, high, owner)
            edges.update(sum_edges(a, b, lengths[left]))
            pending.append((low[exterior], high[exterior], owner[exterior], lengths[exterior]))
    low, high, owner, lengths = [np.concatenate(column) for column in zip(*pending, strict=True)]
    del pending
    order = np.lexsort((high, low))
    owner, lengths = owner[order], lengths[order]
    a, b, left, _, exterior = shared_segments(low[order], high[order], owner)
    for edge, length in sum_edges(a, b, lengths[left]).items():
        edges[edge] = edges.get(edge, 0) + length
    outer = np.bincount(owner[exterior], weights=lengths[exterior], minlength=len(geometry))
    return edges, outer


def nearest(tree, geometry, indices, members=None):
    # STRtree reports all equal-distance candidates. Break ties by block index.
    target = tree if members is None else shapely.STRtree(geometry[members])
    pairs = target.query_nearest(geometry[indices], exclusive=members is None)
    links = {}
    for i, j in pairs.T:
        a, b = int(indices[i]), int(j if members is None else members[j])
        links[a] = min(b, links.get(a, b))
    return links


def corner_audit(geometry, edges, ids):
    tree = shapely.STRtree(geometry)
    point_only = 0
    missed_line = 0
    examples = []
    for start in range(0, len(geometry), 4096):
        a, b = tree.query(geometry[start:start + 4096])
        a += start
        keep = a < b
        candidates = [(i, j) for i, j in zip(a[keep], b[keep]) if (i, j) not in edges]
        if not candidates:
            continue
        a, b = np.asarray(candidates).T
        # DE-9IM entries 0, 1, 3 and 4 describe intersections between interiors
        # and boundaries. Touching polygons have disjoint interiors. Read the
        # dimension of the remaining contact without constructing its geometry.
        for (i, j), relation in zip(candidates, shapely.relate(geometry[a], geometry[b]), strict=True):
            if relation[0] != "F":
                continue
            contacts = relation[1] + relation[3:5]
            if "1" in contacts:
                missed_line += 1
                if len(examples) < 8:
                    examples.append((ids[i], ids[j]))
            elif "0" in contacts:
                point_only += 1
    return point_only, missed_line, examples
