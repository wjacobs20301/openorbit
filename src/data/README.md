# Data files

## `coverage-masks.json`

Outlines that two national imagery layers are clipped to, because their servers paint
filler imagery outside their own country. Each entry is a list of rings, each a flat
`[lon, lat, lon, lat, ...]` array (WGS 84, rounded to 5 decimals), filled even-odd.

- `ch`: Switzerland.
- `es`: Spain with about 3 km of sea, minus Portugal, Andorra, Gibraltar and Morocco. Along
  the Pyrenees it follows Spain's border exactly.

Regenerate with `pip install shapely && python3 scripts/coverage-masks.py`.

Derived from [geoBoundaries](https://www.geoboundaries.org) (Runfola et al., 2020) ADM0
boundaries, each under its source's licence:

| Country | Source licence |
|---|---|
| Switzerland | Federal Office of Topography swisstopo, open government data |
| Spain | CC BY 4.0 |
| Portugal | Open Database License 1.0 |
| Morocco | Open Database License 1.0 |
| Gibraltar | CC BY 4.0 |
| Andorra | Public domain |

Because it includes ODbL data, this file is made available under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
