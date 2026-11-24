"""Extract New York's enacted 118th Congress map for the solver comparison."""
import csv
import io

from format import atomic_write
from inputs import CENSUS, ROOT, download, member, records, unique_rows

URL = CENSUS + "/programs-surveys/decennial/rdo/mapping-files/2023/118-congressional-district-bef/cd118.zip"
MEMBER = "36_NY_CD118.txt"


def main():
    directory = ROOT.parent / "data" / "NY" / "fixtures"
    archive = download(URL, MEMBER)
    with member(archive, MEMBER) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig") as stream:
        rows = csv.DictReader(stream, skipinitialspace=True)
        assignment = unique_rows((row["GEOID"], int(row["CDFP"])) for row in rows)
    with records(directory / "cd119.csv") as rows:
        geoids = [row["GEOID20"] for row in rows]
    if set(geoids) != assignment.keys() or set(assignment.values()) != set(range(1, 27)):
        raise ValueError("NY CD118 blocks or district numbers do not match the bundle")
    atomic_write(directory / "cd118.csv",
                 ("GEOID20,District\n" + "".join(f"{key},{assignment[key]}\n" for key in geoids)).encode())
    print(f"NY CD118: {len(geoids)} blocks in 26 districts")


if __name__ == "__main__":
    main()
