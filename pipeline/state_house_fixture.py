"""Extract Pennsylvania's enacted 203-district 2022 lower house plan."""
from format import atomic_write
from inputs import CENSUS, ROOT, download, records, unique_rows


def main():
    url = CENSUS + "/programs-surveys/decennial/rdo/mapping-files/2023/2022-state-legislative-bef/sldl_2022.zip"
    member = "42_PA_SLDL22.txt"
    archive = download(url, member)
    with records(archive, member) as rows:
        assignment = unique_rows((row["GEOID"], int(row["SLDLST"])) for row in rows)
    if set(assignment.values()) != set(range(1, 204)):
        raise ValueError("Pennsylvania SLDL BEF does not contain districts 1 through 203")
    out = ROOT.parent / "data" / "PA" / "fixtures"
    with records(out / "cd119.csv") as rows:
        geoids = [row["GEOID20"] for row in rows]
    missing = sorted(set(geoids) - assignment.keys())
    extra = sorted(assignment.keys() - set(geoids))
    if missing or extra:
        raise ValueError(f"PA SLDL BEF: missing={len(missing)} {missing[:8]}, extra={len(extra)} {extra[:8]}")
    path = out / "sldl2022.csv"
    data = "GEOID20,District\n" + "".join(f"{geoid},{assignment[geoid]}\n" for geoid in geoids)
    atomic_write(path, data.encode())
    print(f"{path}: {len(geoids)} blocks in 203 districts")


if __name__ == "__main__":
    main()
