# Solver tuning measurements

Every paired request uses the same block assignment. The New York congressional sweep covers 20 seeded
perturbations of CD119. The second New York fixture uses four independent seeds on the enacted CD118
Census block equivalency file. The other states use CD119 with four perturbed blocks per odd-numbered
district and seed 1. California uses D20FA and the other congressional tests use D20F.

Only independently verified solutions contribute to the distributions. Split and total perimeter counts
are recounted on the full bundle graph for both code versions. County increases count additional district
memberships, including in an already split county. Transfer shape uses the land graph and the assignment
at the time of each transfer. Boundary meters per person measure the change in the shared district border
once. Donor percentage is new contact with the donor divided by combined old contact with the recipient
and new contact with the donor. A zero-length denominator is omitted from the donor distribution.

The water suite's one-district runs cover every off-target district across the six perturbed maps.
The shifted-target run includes all 26 districts. A request that needs fallback includes the time
spent in both solvers. The blind runs are diagnostic controls for water handling.
Quantiles are minimum / median / p90 / maximum. Each option contributes plan metrics, and each transfer contributes shape metrics. Times are per original solve request. The infeasible group is counted as a success when rejected.

| Scenario | Version | Success | Options | Seconds | People | Blocks | Precinct splits | Town splits | County increases | Perimeter km | Boundary m/person | Donor % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NY CD119 whole-map sweep | Before | 20/20 | 56 | 2.324 / 3.342 / 5.939 / 8.743 | 1015 / 5530 / 8771 / 9185 | 38 / 118 / 175 / 222 | 6 / 26 / 43 / 69 | 0 / 4 / 7 / 10 | 0 / 2 / 4 / 5 | -88.87 / 7.35 / 112.88 / 188.20 | -1329.6 / 1.1 / 217.8 / 23600.0 | 0.0 / 57.7 / 92.3 / 100.0 |
| NY CD119 whole-map sweep | After | 20/20 | 56 | 2.234 / 3.126 / 3.968 / 5.966 | 1093 / 5602 / 8989 / 9936 | 38 / 110 / 146 / 161 | 7 / 23 / 37 / 53 | 0 / 1 / 3 / 7 | 0 / 1 / 3 / 4 | -66.77 / 8.22 / 62.49 / 136.85 | -1382.8 / 0.7 / 118.3 / 27305.0 | 0.0 / 54.4 / 91.8 / 100.0 |
| NY groups | Before | 8/8 | 13 | 0.048 / 0.442 / 0.883 / 0.918 | 7 / 118 / 793 / 801 | 2 / 6 / 20 / 30 | 0 / 1 / 9 / 9 | 0 / 0 / 1 / 2 | 0 / 0 / 1 / 1 | -2.98 / 1.01 / 17.55 / 18.89 | -282.5 / 0.0 / 423.1 / 3401.0 | 0.5 / 50.1 / 98.5 / 99.8 |
| NY groups | After | 8/8 | 10 | 0.041 / 0.228 / 0.369 / 0.528 | 7 / 135 / 801 / 801 | 2 / 7 / 22 / 33 | 0 / 1 / 9 / 11 | 0 / 0 / 0 / 1 | 0 / 0 / 0 / 0 | -9.42 / 1.06 / 16.69 / 18.21 | -282.5 / 1.1 / 391.4 / 3401.0 | 0.5 / 56.5 / 98.9 / 99.8 |
| NY shifted target | Before | 26/26 | 118 | 0.011 / 0.041 / 0.667 / 1.495 | 1 / 3 / 4 / 48 | 1 / 2 / 23 / 39 | 0 / 1 / 8 / 17 | 0 / 0 / 1 / 2 | 0 / 0 / 1 / 1 | -6.96 / 2.39 / 33.35 / 83.84 | -838.5 / 480.6 / 5723.8 / 14785.0 | 29.6 / 79.5 / 99.6 / 100.0 |
| NY shifted target | After | 26/26 | 118 | 0.011 / 0.037 / 0.283 / 1.152 | 1 / 3 / 4 / 113 | 1 / 3 / 21 / 34 | 0 / 1 / 7 / 17 | 0 / 0 / 1 / 2 | 0 / 0 / 1 / 1 | -6.96 / 2.39 / 28.29 / 83.84 | -620.3 / 472.5 / 3558.1 / 14785.0 | 33.3 / 75.4 / 99.7 / 100.0 |
| NY water suite / blind / whole | Before | 6/6 | 18 | 2.077 / 2.519 / 4.300 / 5.236 | 1009 / 3575 / 5467 / 5616 | 56 / 109 / 172 / 202 | 7 / 32 / 49 / 57 | 0 / 3 / 5 / 6 | 0 / 3 / 5 / 8 | 5.07 / 99.03 / 231.39 / 336.34 | -491.4 / 3.0 / 313.8 / 19142.0 | 0.9 / 62.9 / 99.3 / 100.0 |
| NY water suite / blind / whole | After | 6/6 | 17 | 1.836 / 2.598 / 5.744 / 8.498 | 995 / 3687 / 5511 / 5841 | 58 / 89 / 149 / 190 | 12 / 23 / 38 / 43 | 0 / 1 / 6 / 7 | 0 / 1 / 3 / 6 | -73.52 / 36.24 / 140.77 / 180.17 | -491.4 / 1.4 / 150.6 / 14011.0 | 0.0 / 57.0 / 94.5 / 100.0 |
| NY water suite / blind / one | Before | 137/137 | 685 | 0.003 / 0.016 / 0.037 / 0.183 | 1 / 109 / 818 / 1878 | 1 / 4 / 16 / 120 | 0 / 0 / 1 / 9 | 0 / 0 / 1 / 2 | 0 / 0 / 1 / 2 | -105.08 / 0.78 / 7.74 / 76.05 | -638.4 / 1.4 / 56.0 / 2794.0 | 0.0 / 58.7 / 86.9 / 100.0 |
| NY water suite / blind / one | After | 137/137 | 685 | 0.002 / 0.014 / 0.028 / 0.219 | 1 / 109 / 818 / 1878 | 1 / 3 / 11 / 55 | 0 / 0 / 1 / 9 | 0 / 0 / 0 / 2 | 0 / 0 / 0 / 1 | -105.08 / 0.36 / 4.48 / 30.93 | -1482.0 / 0.5 / 42.3 / 1401.0 | 0.0 / 54.5 / 82.2 / 100.0 |
| NY water suite / landFirst / whole | Before | 6/6 | 17 | 3.079 / 4.838 / 6.620 / 6.966 | 1015 / 3631 / 5599 / 5645 | 43 / 115 / 147 / 151 | 6 / 28 / 46 / 55 | 0 / 2 / 5 / 6 | 0 / 2 / 3 / 5 | -16.30 / 48.23 / 116.52 / 188.20 | -491.4 / 2.3 / 229.3 / 23600.0 | 0.0 / 59.9 / 94.0 / 100.0 |
| NY water suite / landFirst / whole | After | 6/6 | 17 | 2.173 / 3.196 / 3.890 / 3.950 | 1093 / 3626 / 5601 / 5682 | 38 / 97 / 149 / 161 | 10 / 23 / 36 / 45 | 0 / 1 / 3 / 5 | 0 / 1 / 2 / 3 | -26.89 / 32.48 / 79.12 / 124.41 | -491.4 / 1.4 / 176.8 / 23600.0 | 0.0 / 56.7 / 92.3 / 99.9 |
| NY water suite / landFirst / one | Before | 137/137 | 685 | 0.012 / 0.036 / 0.081 / 0.167 | 1 / 109 / 818 / 1878 | 1 / 3 / 12 / 46 | 0 / 0 / 1 / 7 | 0 / 0 / 1 / 2 | 0 / 0 / 0 / 2 | -37.63 / 0.75 / 6.54 / 96.16 | -1779.8 / 1.1 / 50.8 / 2582.8 | 0.0 / 58.0 / 85.1 / 99.5 |
| NY water suite / landFirst / one | After | 137/137 | 685 | 0.013 / 0.032 / 0.068 / 0.171 | 1 / 109 / 818 / 1878 | 1 / 3 / 10 / 36 | 0 / 0 / 1 / 7 | 0 / 0 / 0 / 1 | 0 / 0 / 0 / 1 | -36.47 / 0.43 / 4.50 / 37.54 | -1482.0 / 0.4 / 38.6 / 1401.0 | 0.0 / 54.0 / 81.9 / 99.5 |
| CA cd119.csv | Before | 1/1 | 3 | 16.893 / 16.893 / 16.893 / 16.893 | 14110 / 14193 / 14527 / 14610 | 584 / 610 / 696 / 717 | 23 / 24 / 36 / 39 | 15 / 17 / 17 / 17 | 7 / 7 / 7 / 7 | 352.07 / 522.08 / 816.76 / 890.43 | -1184.2 / 3.1 / 2849.0 / 37589.0 | 8.3 / 54.8 / 91.1 / 99.9 |
| CA cd119.csv | After | 1/1 | 3 | 12.866 / 12.866 / 12.866 / 12.866 | 14141 / 14217 / 14721 / 14847 | 671 / 891 / 897 / 899 | 36 / 38 / 38 / 38 | 7 / 8 / 9 / 9 | 8 / 10 / 10 / 10 | 108.20 / 117.09 / 191.27 / 209.81 | -2269.0 / -0.6 / 3077.1 / 43840.0 | 6.1 / 49.0 / 91.3 / 99.8 |
| TX cd119.csv | Before | 1/1 | 3 | 24.756 / 24.756 / 24.756 / 24.756 | 3553 / 3564 / 3808 / 3869 | 175 / 242 / 268 / 274 | 16 / 28 / 30 / 31 | 1 / 2 / 2 / 2 | 7 / 8 / 9 / 9 | 81.52 / 278.58 / 310.12 / 318.01 | -555.5 / 11.9 / 487.5 / 5972.5 | 6.0 / 61.7 / 87.1 / 99.9 |
| TX cd119.csv | After | 1/1 | 3 | 18.301 / 18.301 / 18.301 / 18.301 | 3540 / 3677 / 4451 / 4644 | 224 / 234 / 257 / 263 | 15 / 26 / 28 / 29 | 0 / 1 / 1 / 1 | 4 / 5 / 6 / 6 | 5.12 / 9.56 / 134.00 / 165.12 | -323.0 / 1.4 / 540.6 / 5972.5 | 6.0 / 51.5 / 81.6 / 99.9 |
| FL cd119.csv | Before | 1/1 | 3 | 5.516 / 5.516 / 5.516 / 5.516 | 5193 / 5237 / 5659 / 5765 | 138 / 148 / 175 / 182 | 4 / 10 / 12 / 13 | 4 / 6 / 7 / 7 | 1 / 5 / 7 / 7 | -24.33 / 39.06 / 187.84 / 225.04 | -405.0 / 3.0 / 196.7 / 1617.8 | 0.0 / 58.4 / 82.2 / 99.7 |
| FL cd119.csv | After | 1/1 | 3 | 9.410 / 9.410 / 9.410 / 9.410 | 5183 / 5232 / 5251 / 5256 | 158 / 159 / 166 / 168 | 10 / 13 / 17 / 18 | 1 / 2 / 2 / 2 | 3 / 4 / 5 / 5 | -8.27 / 6.41 / 140.13 / 173.56 | -405.0 / 2.4 / 614.7 / 39988.5 | 0.0 / 56.7 / 88.1 / 100.0 |
| PA cd119.csv | Before | 1/1 | 3 | 2.621 / 2.621 / 2.621 / 2.621 | 957 / 959 / 1013 / 1026 | 32 / 43 / 46 / 47 | 12 / 18 / 18 / 18 | 9 / 14 / 15 / 15 | 6 / 7 / 7 / 7 | -21.77 / 6.58 / 50.55 / 61.55 | -168.9 / 4.7 / 166.6 / 1835.0 | 22.4 / 57.2 / 92.7 / 96.9 |
| PA cd119.csv | After | 1/1 | 3 | 3.719 / 3.719 / 3.719 / 3.719 | 957 / 978 / 1069 / 1092 | 42 / 51 / 55 / 56 | 11 / 12 / 13 / 13 | 5 / 6 / 6 / 6 | 3 / 4 / 5 / 5 | -14.65 / 36.59 / 72.46 / 81.42 | -100.5 / 9.2 / 153.3 / 861.2 | 21.7 / 57.2 / 91.2 / 99.7 |
| HI cd119.csv | Before | 1/1 | 2 | 0.066 / 0.066 / 0.066 / 0.066 | 51 / 51 / 51 / 51 | 8 / 15 / 20 / 21 | 1 / 1 / 1 / 1 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 20.46 / 28.03 / 34.08 / 35.59 | -2.4 / 133.5 / 242.2 / 269.4 | 49.7 / 64.8 / 76.9 / 79.9 |
| HI cd119.csv | After | 1/1 | 1 | 0.117 / 0.117 / 0.117 / 0.117 | 51 / 51 / 51 / 51 | 18 / 18 / 18 / 18 | 1 / 1 / 1 / 1 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 17.31 / 17.31 / 17.31 / 17.31 | -33.3 / -33.3 / -33.3 / -33.3 | 47.1 / 47.1 / 47.1 / 47.1 |
| ME cd119.csv | Before | 1/1 | 2 | 0.292 / 0.292 / 0.292 / 0.292 | 237 / 237 / 237 / 237 | 4 / 5 / 6 / 6 | 1 / 1 / 1 / 1 | 0 / 1 / 1 / 1 | 0 / 0 / 0 / 0 | -21.74 / -19.14 / -17.06 / -16.54 | -42.2 / -37.3 / -33.4 / -32.4 | 29.3 / 33.4 / 36.7 / 37.6 |
| ME cd119.csv | After | 1/1 | 1 | 0.446 / 0.446 / 0.446 / 0.446 | 237 / 237 / 237 / 237 | 6 / 6 / 6 / 6 | 1 / 1 / 1 / 1 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | -21.74 / -21.74 / -21.74 / -21.74 | -42.2 / -42.2 / -42.2 / -42.2 | 37.6 / 37.6 / 37.6 / 37.6 |
| RI cd119.csv | Before | 1/1 | 1 | 0.177 / 0.177 / 0.177 / 0.177 | 432 / 432 / 432 / 432 | 28 / 28 / 28 / 28 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | -2.08 / -2.08 / -2.08 / -2.08 | -2.8 / -2.8 / -2.8 / -2.8 | 41.3 / 41.3 / 41.3 / 41.3 |
| RI cd119.csv | After | 1/1 | 2 | 0.252 / 0.252 / 0.252 / 0.252 | 432 / 432 / 432 / 432 | 28 / 29 / 30 / 30 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | -2.08 / -1.79 / -1.56 / -1.51 | -3.2 / -3.0 / -2.8 / -2.8 | 40.3 / 40.8 / 41.2 / 41.3 |
| NY cd118.csv whole map | Before | 4/4 | 12 | 2.758 / 3.194 / 3.688 / 3.874 | 8010 / 8554 / 10535 / 11462 | 96 / 127 / 157 / 168 | 11 / 25 / 38 / 38 | 4 / 6 / 9 / 10 | 1 / 3 / 6 / 8 | -69.97 / -7.44 / 26.79 / 49.94 | -710.0 / 0.3 / 82.5 / 8440.0 | 0.0 / 53.7 / 91.4 / 99.9 |
| NY cd118.csv whole map | After | 4/4 | 12 | 2.400 / 3.292 / 4.528 / 4.892 | 8008 / 8546 / 10513 / 11259 | 93 / 123 / 167 / 171 | 12 / 23 / 34 / 36 | 1 / 4 / 6 / 7 | 1 / 3 / 6 / 7 | -84.15 / -37.92 / 0.37 / 5.15 | -710.0 / 0.1 / 76.9 / 12293.0 | 0.0 / 51.9 / 85.3 / 99.9 |

### New York groups by case

| Scenario | Version | Success | Options | Seconds | People | Blocks | Precinct splits | Town splits | County increases | Perimeter km | Boundary m/person | Donor % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chain through a middle district (6 - 7 - 8, 6 and 8 do not touch) | Before | 1/1 | 2 | 0.197 / 0.197 / 0.197 / 0.197 | 801 / 801 / 801 / 801 | 5 / 5 / 5 / 5 | 0 / 1 / 1 / 1 | 0 / 0 / 0 / 0 | 1 / 1 / 1 / 1 | -0.01 / 0.50 / 0.90 / 1.01 | -0.0 / 0.0 / 0.9 / 1.3 | 49.7 / 50.1 / 64.4 / 70.6 |
| chain through a middle district (6 - 7 - 8, 6 and 8 do not touch) | After | 1/1 | 2 | 0.181 / 0.181 / 0.181 / 0.181 | 801 / 801 / 801 / 801 | 5 / 7 / 8 / 8 | 0 / 1 / 1 / 1 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0.22 / 0.42 / 0.57 / 0.61 | 0.0 / 0.1 / 0.6 / 0.8 | 50.1 / 52.2 / 55.9 / 56.5 |
| small chain (6 - 7 - 8) | Before | 1/1 | 2 | 0.508 / 0.508 / 0.508 / 0.508 | 15 / 15 / 15 / 15 | 3 / 4 / 4 / 4 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | -2.98 / -2.70 / -2.47 / -2.42 | -114.9 / -98.3 / -53.5 / -41.4 | 10.6 / 20.7 / 24.0 / 24.0 |
| small chain (6 - 7 - 8) | After | 1/1 | 1 | 0.161 / 0.161 / 0.161 / 0.161 | 15 / 15 / 15 / 15 | 4 / 4 / 4 / 4 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | -2.98 / -2.98 / -2.98 / -2.98 | -114.9 / -98.3 / -85.0 / -81.7 | 10.6 / 17.3 / 22.7 / 24.0 |
| chain through a middle district (17 - 18 - 19, 17 and 19 do not touch) | Before | 1/1 | 2 | 0.868 / 0.868 / 0.868 / 0.868 | 761 / 761 / 761 / 761 | 11 / 12 / 12 / 12 | 0 / 1 / 1 / 1 | 1 / 2 / 2 / 2 | 0 / 0 / 0 / 0 | 0.27 / 0.32 / 0.36 / 0.37 | -1.1 / 0.2 / 1.5 / 1.6 | 49.2 / 50.2 / 51.3 / 51.3 |
| chain through a middle district (17 - 18 - 19, 17 and 19 do not touch) | After | 1/1 | 1 | 0.264 / 0.264 / 0.264 / 0.264 | 761 / 761 / 761 / 761 | 21 / 21 / 21 / 21 | 1 / 1 / 1 / 1 | 1 / 1 / 1 / 1 | 0 / 0 / 0 / 0 | -9.42 / -9.42 / -9.42 / -9.42 | -13.8 / -6.2 / -0.1 / 1.4 | 42.6 / 46.9 / 50.4 / 51.3 |
| small chain (17 - 18 - 19) | Before | 1/1 | 1 | 0.498 / 0.498 / 0.498 / 0.498 | 24 / 24 / 24 / 24 | 2 / 2 / 2 / 2 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | -0.49 / -0.49 / -0.49 / -0.49 | -21.0 / -11.0 / -3.0 / -1.0 | 23.2 / 36.4 / 47.0 / 49.6 |
| small chain (17 - 18 - 19) | After | 1/1 | 1 | 0.237 / 0.237 / 0.237 / 0.237 | 24 / 24 / 24 / 24 | 2 / 2 / 2 / 2 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | -0.49 / -0.49 / -0.49 / -0.49 | -21.0 / -11.0 / -3.0 / -1.0 | 23.2 / 36.4 / 47.0 / 49.6 |
| 4 districts (internal moves on 7/8, 7/10, 8/9, 8/10) | Before | 1/1 | 2 | 0.918 / 0.918 / 0.918 / 0.918 | 166 / 175 / 181 / 183 | 14 / 22 / 28 / 30 | 8 / 9 / 9 / 9 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 14.95 / 16.92 / 18.49 / 18.89 | -14.3 / 4.2 / 1102.1 / 1869.0 | 33.0 / 59.8 / 99.0 / 99.8 |
| 4 districts (internal moves on 7/8, 7/10, 8/9, 8/10) | After | 1/1 | 2 | 0.528 / 0.528 / 0.528 / 0.528 | 152 / 215 / 265 / 278 | 17 / 25 / 31 / 33 | 6 / 9 / 11 / 11 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 7.71 / 12.12 / 15.64 / 16.52 | -1.3 / 21.3 / 217.4 / 1045.8 | 33.0 / 82.2 / 98.9 / 99.8 |
| 5 districts (internal moves on 10/11, 10/12, 12/13, 13/15) | Before | 1/1 | 2 | 0.337 / 0.337 / 0.337 / 0.337 | 118 / 118 / 118 / 118 | 17 / 19 / 21 / 21 | 9 / 9 / 9 / 9 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 7.26 / 9.76 / 11.76 / 12.26 | -282.5 / 6.4 / 384.3 / 423.1 | 0.5 / 48.1 / 96.0 / 98.9 |
| 5 districts (internal moves on 10/11, 10/12, 12/13, 13/15) | After | 1/1 | 1 | 0.300 / 0.300 / 0.300 / 0.300 | 118 / 118 / 118 / 118 | 21 / 21 / 21 / 21 | 9 / 9 / 9 / 9 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 7.26 / 7.26 / 7.26 / 7.26 | -282.5 / 6.4 / 228.9 / 423.1 | 0.5 / 48.1 / 84.4 / 98.9 |
| cannot balance on its own (8 took people from 5) | Before | 1/1 | 0 | 0.048 / 0.048 / 0.048 / 0.048 | — | — | — | — | — | — | — | — |
| cannot balance on its own (8 took people from 5) | After | 1/1 | 0 | 0.041 / 0.041 / 0.041 / 0.041 | — | — | — | — | — | — | — | — |
| one district (15), neighbors absorb | Before | 1/1 | 2 | 0.387 / 0.387 / 0.387 / 0.387 | 7 / 8 / 8 / 8 | 2 / 4 / 6 / 6 | 1 / 3 / 4 / 4 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 1.50 / 9.85 / 16.54 / 18.21 | 107.3 / 383.5 / 2797.5 / 3401.0 | 89.1 / 89.6 / 95.2 / 96.6 |
| one district (15), neighbors absorb | After | 1/1 | 2 | 0.220 / 0.220 / 0.220 / 0.220 | 7 / 8 / 8 / 8 | 2 / 4 / 6 / 6 | 1 / 3 / 4 / 4 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 1.50 / 9.85 / 16.54 / 18.21 | 107.3 / 383.5 / 2797.5 / 3401.0 | 89.1 / 89.6 / 95.2 / 96.6 |

### Whole-map split and spindle incidence

| Scenario | Version | Precinct splits | Town splits | Plans with town splits | County increases | Plans with county increases | Donor contact ≥80% | Transfers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NY CD119 whole-map sweep | Before | 1472 | 220 | 52 | 104 | 50 | 236 | 1229 |
| NY CD119 whole-map sweep | After | 1334 | 96 | 45 | 79 | 43 | 207 | 1206 |
| NY groups | Before | 42 | 3 | 2 | 2 | 2 | 9 | 41 |
| NY groups | After | 33 | 1 | 1 | 0 | 0 | 10 | 29 |
| NY water suite / blind / whole | Before | 563 | 54 | 16 | 53 | 17 | 112 | 364 |
| NY water suite / blind / whole | After | 426 | 37 | 12 | 29 | 13 | 68 | 329 |
| NY water suite / landFirst / whole | Before | 460 | 43 | 15 | 30 | 15 | 84 | 349 |
| NY water suite / landFirst / whole | After | 418 | 22 | 10 | 19 | 12 | 67 | 344 |
| CA cd119.csv | Before | 86 | 49 | 3 | 21 | 3 | 28 | 155 |
| CA cd119.csv | After | 112 | 24 | 3 | 28 | 3 | 25 | 157 |
| TX cd119.csv | Before | 75 | 5 | 3 | 24 | 3 | 19 | 106 |
| TX cd119.csv | After | 70 | 2 | 2 | 15 | 3 | 13 | 98 |
| FL cd119.csv | Before | 27 | 17 | 3 | 13 | 3 | 10 | 80 |
| FL cd119.csv | After | 41 | 5 | 3 | 12 | 3 | 14 | 79 |
| PA cd119.csv | Before | 48 | 38 | 3 | 20 | 3 | 7 | 45 |
| PA cd119.csv | After | 36 | 17 | 3 | 12 | 3 | 9 | 46 |
| HI cd119.csv | Before | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| HI cd119.csv | After | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| ME cd119.csv | Before | 2 | 1 | 1 | 0 | 0 | 0 | 2 |
| ME cd119.csv | After | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| RI cd119.csv | Before | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| RI cd119.csv | After | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| NY cd118.csv whole map | Before | 316 | 81 | 12 | 43 | 12 | 62 | 294 |
| NY cd118.csv whole map | After | 287 | 44 | 12 | 40 | 12 | 45 | 295 |

### Matched transfer examples on the same border and exact population

| Case | Pair | People | Blocks before → after | Boundary m/person before → after | Donor % before → after |
| --- | --- | --- | --- | --- | --- |
| sweep/3/2 | 21 → 22 | 20 | 2 → 6 | 44.1 → -1382.8 | 62.9 → 7.9 |
| sweep/2/4 | 17 → 18 | 216 | 6 → 2 | 4.6 → -27.7 | 52.4 → 7.9 |
| real/NY/D20F/cd118.csv/4/1 | 9 → 10 | 740 | 6 → 1 | 3.7 → 0.0 | 94.5 → 50.1 |
| real/NY/D20F/cd118.csv/4/2 | 17 → 16 | 42 | 18 → 11 | 137.8 → -13.2 | 81.7 → 37.4 |
| real/FL/D20F/cd119.csv/4/1 | 1 → 2 | 69 | 2 → 7 | 28.8 → -34.1 | 81.7 → 37.5 |
| real/CA/D20FA/cd119.csv/4/1 | 23 → 20 | 7 | 1 → 7 | 456.7 → -149.7 | 89.7 → 46.2 |
| sweep/4/1 | 23 → 19 | 5 | 17 → 1 | 3056.0 → -263.6 | 80.8 → 41.3 |
| real/NY/D20F/cd118.csv/4/1 | 19 → 23 | 70 | 3 → 2 | -10.2 → -105.8 | 47.5 → 8.3 |
| real/FL/D20F/cd119.csv/4/1 | 13 → 14 | 831 | 14 → 4 | 1.6 → -6.5 | 61.4 → 24.3 |
| real/FL/D20F/cd119.csv/4/1 | 17 → 16 | 639 | 3 → 3 | -8.2 → 5.1 | 22.7 → 87.6 |
| sweep/3/2 | 5 → 4 | 316 | 4 → 8 | -2.1 → 9.8 | 35.5 → 96.7 |
| real/CA/D20FA/cd119.csv/4/1 | 8 → 4 | 1 | 1 → 1 | -409.0 → 7290.0 | 47.7 → 98.2 |
| sweep/4/2 | 17 → 16 | 166 | 7 → 3 | -40.3 → 1.4 | 7.1 → 57.7 |

### Water contiguity

| Mode | Before | After |
| --- | --- | --- |
| Land-first whole-map transfers | 3 of 349 | 0 of 344 |
| Land-first one-district options | 0 of 685 | 0 of 685 |
| Water-blind whole-map transfers | 47 of 364 | 23 of 329 |
| Water-blind one-district options | 52 of 685 | 13 of 685 |

### Synthetic engine benchmark

All rows yielded five independently verified options. Times include verification and are in milliseconds.

| Deviation | Before | After |
| --- | ---: | ---: |
| 37 | 79.9 | 76.6 |
| 487 | 106.0 | 98.9 |
| 1,237 | 149.2 | 97.4 |
| 4,800 | 531.1 | 210.6 |
| 4,999 | 296.8 | 393.5 |

### Florida retry

The first tuned pass returned a 63-block transfer for one person from District 18 to 20, and an
85-block transfer for 17 people from District 7 to 11. The final planner tried those plans again
with the respective directions closed. Both candidates verified and scored better. Compared with
the first tuning pass, the fewest-splits plan moved 235 → 168 blocks and its perimeter change went
from +409.49 km to −8.27 km. The fewest-districts plan moved 239 → 158 blocks and its perimeter change
went from +252.85 km to +173.56 km. The retry added two flow attempts to the fixture.

## Compact transfers and walkthrough cost

This follow-up uses the previous tuning pass as its baseline. `ny-reach.ts` runs six seeded
CD119 perturbations in New York and the first of those seeds in each of the seven other states.
Both California runs use adjusted population (D20FA). The other states use D20F.
The script replays the transfers in order, measures hops through the moved blocks, verifies
every returned plan, and checks the reported walkthrough count and plan-level `longReach` flag.

Quantiles are **median / p90 / maximum**. Violations are counts of transfers deeper than four
hops, transfers with a majority of empty blocks, and transfers touching four or more precincts.
The legacy search had no `longReach` flag.

| State | Version | Plans / transfers | Steps per plan | Blocks per transfer | Empty blocks | Precincts | Depth | Violations | Flagged transfers |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | ---: |
| NY | Before | 17 / 344 | 51 / 64 / 81 | 3 / 12 / 37 | 0 / 9 / 33 | 2 / 5 / 16 | 1 / 4 / 25 | 27 / 64 / 54 | — |
| NY | After | 11 / 225 | 31 / 34 / 43 | 2 / 4 / 26 | 0 / 0 / 23 | 1 / 2 / 6 | 1 / 2 / 14 | 3 / 4 / 5 | 4 |
| CA | Before | 3 / 134 | 98 / 131 / 131 | 5 / 19 / 128 | 3 / 14 / 112 | 1 / 5 / 12 | 2 / 8 / 25 | 22 / 72 / 21 | — |
| CA | After | 3 / 153 | 63 / 64 / 64 | 1 / 3 / 11 | 0 / 0 / 2 | 1 / 2 / 3 | 1 / 2 / 2 | 0 / 0 / 0 | 0 |
| TX | Before | 3 / 58 | 23 / 30 / 30 | 2 / 15 / 24 | 0 / 9 / 14 | 1 / 2 / 4 | 1 / 4 / 14 | 4 / 14 / 1 | — |
| TX | After | 3 / 55 | 20 / 23 / 23 | 1 / 4 / 6 | 0 / 0 / 2 | 1 / 2 / 2 | 1 / 2 / 3 | 0 / 0 / 0 | 0 |
| FL | Before | 2 / 28 | 17 / 17 / 17 | 1 / 1 / 19 | 0 / 0 / 18 | 1 / 1 / 4 | 1 / 1 / 19 | 1 / 1 / 1 | — |
| FL | After | 2 / 28 | 15 / 15 / 15 | 1 / 1 / 3 | 0 / 0 / 0 | 1 / 1 / 2 | 1 / 1 / 2 | 0 / 0 / 0 | 0 |
| PA | Before | 3 / 31 | 13 / 13 / 13 | 1 / 4 / 14 | 0 / 3 / 12 | 1 / 2 / 2 | 1 / 2 / 5 | 3 / 5 / 0 | — |
| PA | After | 2 / 20 | 12 / 12 / 12 | 1 / 2 / 2 | 0 / 0 / 0 | 1 / 2 / 2 | 1 / 1 / 2 | 0 / 0 / 0 | 0 |
| HI | Before | 1 / 1 | 3 / 3 / 3 | 26 / 26 / 26 | 16 / 16 / 16 | 3 / 3 / 3 | 4 / 4 / 4 | 0 / 1 / 0 | — |
| HI | After | 1 / 1 | 3 / 3 / 3 | 7 / 7 / 7 | 0 / 0 / 0 | 3 / 3 / 3 | 2 / 2 / 2 | 0 / 0 / 0 | 0 |
| ME | Before | 1 / 1 | 2 / 2 / 2 | 4 / 4 / 4 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 0 / 0 / 0 | — |
| ME | After | 1 / 1 | 2 / 2 / 2 | 2 / 2 / 2 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 | 0 / 0 / 0 | 0 |
| RI | Before | 2 / 2 | 5 / 5 / 5 | 31 / 31 / 31 | 20 / 20 / 20 | 5 / 5 / 5 | 3 / 3 / 3 | 0 / 2 / 2 | — |
| RI | After | 1 / 1 | 1 / 1 / 1 | 9 / 9 / 9 | 0 / 0 / 0 | 1 / 1 / 1 | 4 / 4 / 4 | 0 / 0 / 0 | 0 |

Every reach run returned a verified plan. The median New York walkthrough shrank by 39%, and
p90 shrank by 47%. All 221 unflagged transfers stayed within four hops and had at least as
many occupied blocks as empty ones. The four flagged transfers (1.78%) all came from the
same assignment, zero-based run 1 of `ny-reach.ts` and two blocks per district with seed 2
of `ny-sweep.ts`.

### Transfer examples

| Fixture and direction | Before | After |
| --- | --- | --- |
| HI reach run 0, 2 → 1 | 978 people, 26 blocks, 16 empty, 3 steps, depth 4 | 978 people, 7 occupied blocks, 3 steps, depth 2 |
| TX reach run 0, 37 → 21 | 630 people, 24 blocks, 14 empty, 2 steps, depth 5 | 630 people, 3 occupied blocks, 1 step, depth 2 |
| RI reach run 0, 2 → 1 | 508 people, 31 blocks, 20 empty, 5 steps, depth 3 | 508 people, 9 occupied blocks, 1 step, depth 4 |
| NY reach run 2 | The fewest-blocks plan moved 5 people from 8 → 7 using 25 blocks, 24 empty, across 11 precincts at depth 25 | The fewest-blocks plan took a different route. Its deepest transfer was 5 → 6 with 1,406 people in 8 occupied blocks across 2 precincts at depth 3. |
| NY reach run 1, 11 → 10 | 223 people, 25 blocks, 23 empty, 10 steps, depth 24 | The last resort moved 223 people in 9 blocks, 6 empty, across 4 precincts at depth 6. |

The other flagged transfers in NY reach run 1 were 5 → 6 (40 people, 14 blocks, 13 empty,
depth 14), 9 → 10 (100 people, 11 blocks, 9 empty, depth 10), and 7 → 10 (37 people,
26 blocks, 23 empty, depth 3). The three compact attempt kinds reached residuals of
8 under in District 14, 17 under in District 10, and 21 under in District 12,
respectively. The retry returned one independently verified plan with all 26 districts zeroed.

### Coverage and timings

The New York sweep verified all 26 districts in all 20 runs, with 43 distinct verified
plans compared with 56 before. The sweep median took 2.09 seconds and the slowest run took
7.36 seconds. The six reach runs took 1.42–7.85 seconds, with the same relaxed fixture
taking the most time.

`ny-groups.ts` passed all eight scenarios, including the infeasible group, with both its
current setup and the saved baseline assignments. The shifted-target `ny-fallback.ts`
test verified all 26 districts. Direct solving covered 20, and compact planner trades
covered Districts 4, 9, 10, 11, 12 and 13.

The land-first water audit stayed at zero water-dependent transfers (0/344 before and
0/225 after). The direct district audit stayed at zero water-dependent options (0/685
before and 0/649 after). District 13 in zero-based run 3 required a separate group-of-one
solve, which returned a verified, compact two-step trade. The water-blind control went
from 23/329 to 7/291 water-dependent whole-map transfers and from 13/685 to 6/651
water-dependent direct options.

`phase8-real.sh CA TX FL PA HI ME RI` passed every congressional fixture. Every output
plan zeroed every selected district and used compact transfers.

| State | Districts zeroed | Verified plans | Previous solve s | Compact solve s |
| --- | ---: | ---: | ---: | ---: |
| CA | 52 | 3 | 12.866 | 8.533 |
| TX | 38 | 3 | 18.301 | 6.722 |
| FL | 28 | 3 | 9.410 | 2.972 |
| PA | 17 | 3 | 3.719 | 2.442 |
| HI | 2 | 1 | 0.117 | 0.140 |
| ME | 2 | 1 | 0.446 | 0.282 |
| RI | 2 | 1 | 0.252 | 0.193 |

| Synthetic deviation | Previous total ms | Compact total ms | Verified options |
| --- | ---: | ---: | ---: |
| 37 | 76.6 | 76.7 | 5 |
| 487 | 98.9 | 69.5 | 5 |
| 1,237 | 97.4 | 102.9 | 5 |
| 4,800 | 210.6 | 290.7 | 5 |
| 4,999 | 393.5 | 260.2 | 5 |

The engine benchmark includes independent replay and verification in every timing.
Both packages passed typechecking. The engine passed 41 tests. The planner passed 71 tests
with the reference solver and 71 with the engine.

### Tradeoffs

Whole-map success held on the measured fixtures. Fewer alternative plans survived strict
search in New York, and the relaxed fixture took longer than a typical compact run.
Across the 20-run sweep, transfers with at least 80% of their shared boundary contact facing
the donor went from 207 of 1,206 (17.2%) to 128 of 975 (13.1%). Median blocks moved per plan
declined from 110 to 55, and median new precinct splits declined from 23 to 15. Median new
town splits rose from one to two, and median gross population moved rose from 5,602 to 6,166.
Median total perimeter change went from +8.22 km to −2.84 km.
A synthetic unfinished map with empty blocks scattered through precincts finished with
88 new precinct splits. The three prior plans on the same assignment had 5–11.
The compact rules reduce whole-precinct opportunities in this geometry. The tests keep
the original assignment for coverage of large imbalances and exercise the whole-precinct
split limit on a fully occupied fixture.

A compact transfer reaches the recipient's prior territory in at most four hops. Occupied
blocks have a route through moved occupied blocks, and empty pockets travel only when
attached to the bite and cut off from the remaining donor. Each move can carry at most
one empty block per occupied block. The planner reserves the wider search for requests
with zero verified compact plans. It rechecks land routes before keeping a crossing
identified by the border solver.

The default price is 240 per painted precinct per transfer. The exact plan score also
adds 240 per shared border used. The flow charges fixed costs of 420, 450, and 620 in
score units for the fewest-splits, fewest-blocks, and fewest-districts kinds. The prior
geography and shape weights stay at 100 per new precinct split, −85 per healed split,
800 per county membership, 420 per new town split, and 0.006 per perimeter meter.
The block and populated-block prices are 0.06 and 0.08, and the neighbor deviation
price is 0.01 per person. The fewest-blocks kind uses 0.72 and 2 per block and populated
block, and 70 per new precinct split.

Verification used the enacted congressional fixtures and a synthetic reproduction of the
waterfront chain. The owner's original 20-district assignment, the Pennsylvania House
fixture, and the live extension workflow remain outside this verification.

## Whole precincts as one unit (integration follow-up)

The compact rule above also refused a precinct taken whole whenever it held more empty blocks
than occupied ones, was more than four blocks deep, or touched the recipient only with an empty
block, and the candidate ring left out every empty block, so on real data most whole-precinct
moves disappeared (the sparse unfinished fixture's split count rose from 5–11 to 88, and the
extension's whole-precinct paint test found no whole-precinct step at all).

A precinct that lies entirely in the donor and is taken whole is now one unit: its blocks all
count as occupied, steps inside it add no depth, its growth is not held to the block ring, and
an empty border block can seed it. The donor's fragment of an already-split precinct is still
judged block by block. See `packages/engine/src/compact.ts` and `computeRing` in `search.ts`.

After this change, New York (`ny-reach.ts NY 6`): steps per plan 30 / 37 / 44 (median / p90 /
max), 4 of 234 transfers flagged `longReach`, 0 transfers leaning on water; `ny-sweep.ts`: no
run without a verified plan. Engine 43 tests, planner 71 in each mode, benchmark under 0.25 s
per row.
