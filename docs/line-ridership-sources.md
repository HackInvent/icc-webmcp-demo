# Line ridership reference

`src/rail/lineRidership.ts` provides one sourced passenger-journey reference for
all 21 native lines: the 16 Paris Metro lines and RER A–E. Consumers should keep
the year, qualifier, source and annualisation method attached to every value.

## Metro: official annual journeys for 2025

The Metro values come from the official OMNIL / Île-de-France Mobilités workbook
[2025 annual traffic workbook](https://omnil.cdn.prismic.io/omnil/ajFb3Y1P9HI4Uk5i_TCC_trafic_annuel_2025.xlsx),
Metro annual journeys sheet, 2025 column. OMNIL's
[methodology page](https://omnil.fr/trafic-annuel-et-journalier) explains that
Metro uses entries from the street, surface network or RER; Metro-to-Metro
transfers are not counted again. Annual counts cover weekdays, weekends,
holidays and school-holiday periods.

| Line | 2025 annual journeys |
|---|---:|
| M1 | 168,740,000 |
| M2 | 92,260,000 |
| M3 | 80,420,000 |
| M3bis | 1,420,000 |
| M4 | 167,460,000 |
| M5 | 105,230,000 |
| M6 | 100,480,000 |
| M7 | 118,940,000 |
| M7bis | 3,390,000 |
| M8 | 105,540,000 |
| M9 | 128,770,000 |
| M10 | 43,730,000 |
| M11 | 52,370,000 |
| M12 | 84,040,000 |
| M13 | 117,630,000 |
| M14 | 152,210,000 |
| **Metro total** | **1,522,630,000** |

The workbook reports millions to two decimal places. Integer values retain that
published 10,000-journey precision. It also states that line 14 validations for
the new Pleyel–Orly–Villejuif Gustave Roussy stations are estimated from ticketing
data.

## RER: official daily references

The available operator/authority figures are rounded daily headlines, not annual
audited totals. `annualPassengerJourneys` is therefore a transparent
`dailyPassengerJourneys × 365` reference, and every RER record carries
`annualizationMethod: "daily_reference_x_365"`.

| Line | Reference year | Daily reference | Annual reference (×365) | Official source |
|---|---:|---:|---:|---|
| RER A | 2024 | about 1,100,000 | 401,500,000 | [RATP service update](https://www.ratp.fr/mobilisespourvous) |
| RER B | 2025 | nearly 1,000,000 | 365,000,000 | [IDFM emergency action plan update](https://presse.iledefrance-mobilites.fr/rer-b-le-redressement-se-poursuit-grace-au-plan-daction-durgence/?lang=fr) |
| RER C | 2024 | about 540,000 | 197,100,000 | [IDFM RER C master plan](https://presse.iledefrance-mobilites.fr/schema-directeur-du-rer-c-4-milliards-deuros-pour-transformer-la-ligne/?lang=fr) |
| RER D | 2025 context | about 630,000 | 229,950,000 | [Transilien modernisation overview](https://www.transilien.com/fr/premieres-lignes/la-ligne-D-du-RER-poursuit-sa-modernisation) |
| RER E | 2025 | about 600,000 | 219,000,000 | [Transilien post-extension traffic guidance](https://malignee.transilien.com/2025/01/14/forte-affluence-sur-le-rer-e-adoptez-les-bons-reflexes-et-optimisez-vos-trajets/) |

The RER E reference deliberately uses the post-Nanterre-la-Folie value reported
in January 2025. The same source gives 370,000 as the pre-extension baseline.

## Safe use and limits

- Do not describe the RER annual references as measured annual totals. They are
  simple unit conversions and do not model weekdays, weekends or seasonality.
- RER sources have different publication years and definitions; their annualized
  values must not be summed as a same-year audited network total.
- OMNIL uses `voyages`/`utilisations` for observed traffic and explains that
  `voyageurs` is more often used for forecasts. Keep the source terminology in
  public-facing explanations.
- The dataset is suitable for relative demand calibration when provenance remains
  visible. Simulated queues and loads derived from it remain model outputs, not
  official observations.
