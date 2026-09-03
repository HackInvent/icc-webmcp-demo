# Rail reference baseline

Consulted on 26 August 2026. These references anchor the static line facts shown
in the application; they are not live operational feeds.

## Sourced full-line facts

| Line | Facts represented in the application | Wikipedia source |
| --- | --- | --- |
| RER A | 109 km, 46 stations, east–west branched line, RATP/SNCF operation, SACEM on the central section, MI 09 and MI 2N Altéo, 1.5 kV DC and 25 kV AC domains | [Ligne A du RER d'Île-de-France](https://fr.wikipedia.org/wiki/Ligne_A_du_RER_d%27%C3%8Ele-de-France) |
| RER B | 80 km, 47 stations, north-east–south-west branches, RATP/SNCF operation, MI 79 and MI 84, 1.5 kV DC south and 25 kV AC north | [Ligne B du RER d'Île-de-France](https://fr.wikipedia.org/wiki/Ligne_B_du_RER_d%27%C3%8Ele-de-France) |
| Metro 13 | 24.4 km, 32 stations, two northern branches, RATP, MF 77, driver with OURAGAN train control | [Ligne 13 du métro de Paris](https://fr.wikipedia.org/wiki/Ligne_13_du_m%C3%A9tro_de_Paris) and [MF 77](https://fr.wikipedia.org/wiki/MF_77) |
| Metro 14 | 27.8 km, 21 stations, Saint-Denis–Pleyel to Aéroport d'Orly, RATP, fully automatic SAET, eight-car MP 14 CA | [Ligne 14 du métro de Paris](https://fr.wikipedia.org/wiki/Ligne_14_du_m%C3%A9tro_de_Paris) and [MP 14](https://fr.wikipedia.org/wiki/MP_14) |


## Mission-routing baseline

| Line | Mission seed | Referenced branch routing |
| --- | --- | --- |
| RER A | QYAN | Cergy-le-Haut → Marne-la-Vallée–Chessy |
| RER A | NELY | Saint-Germain-en-Laye → Boissy-Saint-Léger |
| RER A | UPAC | Marne-la-Vallée–Chessy → Cergy-le-Haut |
| RER B | ERIO | Massy–Palaiseau → Aéroport Charles de Gaulle 2 TGV |
| RER B | ILOT | Robinson → Mitry - Claye |
| RER B | KALI | Aéroport Charles de Gaulle 2 TGV → Massy–Palaiseau |

The alphabetic codes and branch routings were checked against the service-pattern
sections of the same RER A and RER B references. Numeric suffixes, train assignments,
exact times, and passenger loads remain fictional. The single driver token per
service is a planning proxy: the real RER A operator handover at Nanterre-Préfecture
for Cergy and Poissy through services is not modelled.
## Deliberate simulation boundary

The schematic uses six consecutive central control points per line, not the complete
passenger map. Full termini, line length, station count, rolling stock, control mode,
and power systems are reference facts. Train positions, delays, passenger counts,
driver tokens, CDV boundaries, electrical-section telemetry, incident timestamps,
segment lengths, segment speed limits, and the D-1 timetable remain deterministic
fictional scenario data. The next-day timetable and day-of moving snapshot use
separate scenario dates. The ×1/×2/×4 controls change the simulation speed; they do not describe a
real railway clock.

The represented RER central corridors are powered at 1.5 kV DC. The cards also show
the 25 kV AC domains used elsewhere on the complete RER A and RER B routes; this does
not imply that the simulated Paris tunnels are energized at 25 kV.
