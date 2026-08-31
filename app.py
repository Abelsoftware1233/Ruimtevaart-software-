"""
Zonnestelsel backend
=====================
Berekent de actuele (live) posities van de planeten in ons zonnestelsel
met behulp van benaderde Kepler-baanelementen (gebaseerd op de bekende
J2000-epoch elementen zoals gepubliceerd door NASA/JPL). Dit werkt volledig
offline: er is geen internetverbinding of externe ephemeris-database nodig.

Serveert:
  GET /                -> index.html (frontend)
  GET /script.js        -> frontend logica
  GET /api/positions    -> actuele 3D-posities van zon, planeten en de maan
  GET /api/positions?t=<iso datetime>&speed=<dagen/sec> -> voor tijd-simulatie
"""

import math
from datetime import datetime, timezone
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder=None)

AU = 1.0  # we werken in Astronomische Eenheden

# -----------------------------------------------------------------------
# Kepler-baanelementen (J2000.0 epoch) + hun seculaire (per-eeuw) verandering
# bron: standaardtabellen laagfrequente planeetelementen (JPL / Meeus)
# a: halve lange as (AU), e: excentriciteit, i: inclinatie (graden)
# L: gemiddelde lengte (graden), varpi: lengte perihelium (graden)
# Omega: lengte klimmende knoop (graden)
# elke waarde is [waarde_bij_J2000, verandering_per_eeuw]
# -----------------------------------------------------------------------
ORBITAL_ELEMENTS = {
    "mercurius": {
        "a": [0.38709927, 0.00000037], "e": [0.20563593, 0.00001906],
        "i": [7.00497902, -0.00594749], "L": [252.25032350, 149472.67411175],
        "varpi": [77.45779628, 0.16047689], "Omega": [48.33076593, -0.12534081],
        "radius_km": 2439.7, "color": [0x9c, 0x8f, 0x7c], "period_days": 87.969,
    },
    "venus": {
        "a": [0.72333566, 0.00000390], "e": [0.00677672, -0.00004107],
        "i": [3.39467605, -0.00078890], "L": [181.97909950, 58517.81538729],
        "varpi": [131.60246718, 0.00268329], "Omega": [76.67984255, -0.27769418],
        "radius_km": 6051.8, "color": [0xe8, 0xc3, 0x8a], "period_days": 224.701,
    },
    "aarde": {
        "a": [1.00000261, 0.00000562], "e": [0.01671123, -0.00004392],
        "i": [-0.00001531, -0.01294668], "L": [100.46457166, 35999.37244981],
        "varpi": [102.93768193, 0.32327364], "Omega": [0.0, 0.0],
        "radius_km": 6371.0, "color": [0x3a, 0x7b, 0xd5], "period_days": 365.256,
    },
    "mars": {
        "a": [1.52371034, 0.00001847], "e": [0.09339410, 0.00007882],
        "i": [1.84969142, -0.00813131], "L": [-4.55343205, 19140.30268499],
        "varpi": [-23.94362959, 0.44441088], "Omega": [49.55953891, -0.29257343],
        "radius_km": 3389.5, "color": [0xc1, 0x5a, 0x3a], "period_days": 686.980,
    },
    "jupiter": {
        "a": [5.20288700, -0.00011607], "e": [0.04838624, -0.00013253],
        "i": [1.30439695, -0.00183714], "L": [34.39644051, 3034.74612775],
        "varpi": [14.72847983, 0.21252668], "Omega": [100.47390909, 0.20469106],
        "radius_km": 69911.0, "color": [0xd8, 0xb0, 0x8a], "period_days": 4332.589,
    },
    "saturnus": {
        "a": [9.53667594, -0.00125060], "e": [0.05386179, -0.00050991],
        "i": [2.48599187, 0.00193609], "L": [49.95424423, 1222.49362201],
        "varpi": [92.59887831, -0.41897216], "Omega": [113.66242448, -0.28867794],
        "radius_km": 58232.0, "color": [0xe4, 0xd2, 0xa6], "period_days": 10759.22,
        "has_rings": True,
    },
    "uranus": {
        "a": [19.18916464, -0.00196176], "e": [0.04725744, -0.00004397],
        "i": [0.77263783, -0.00242939], "L": [313.23810451, 428.48202785],
        "varpi": [170.95427630, 0.40805281], "Omega": [74.01692503, 0.04240589],
        "radius_km": 25362.0, "color": [0x9f, 0xe0, 0xe8], "period_days": 30688.5,
    },
    "neptunus": {
        "a": [30.06992276, 0.00026291], "e": [0.00859048, 0.00005105],
        "i": [1.77004347, 0.00035372], "L": [-55.12002969, 218.45945325],
        "varpi": [44.96476227, -0.32241464], "Omega": [131.78422574, -0.00508664],
        "radius_km": 24622.0, "color": [0x4c, 0x6f, 0xe8], "period_days": 60182.0,
    },
}

# Volgorde voor consistente output
PLANET_ORDER = ["mercurius", "venus", "aarde", "mars", "jupiter", "saturnus", "uranus", "neptunus"]

SUN_RADIUS_KM = 696340.0

DEG2RAD = math.pi / 180.0


def julian_centuries_since_j2000(dt: datetime) -> float:
    """Aantal Juliaanse eeuwen sinds epoch J2000.0 (1 jan 2000, 12:00 UTC)."""
    j2000 = datetime(2000, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    delta_days = (dt - j2000).total_seconds() / 86400.0
    return delta_days / 36525.0


def solve_kepler(M_rad: float, e: float, tol=1e-8, max_iter=100) -> float:
    """Los Kepler-vergelijking M = E - e*sin(E) op naar excentrische anomalie E, via Newton-Raphson."""
    E = M_rad if e < 0.8 else math.pi
    for _ in range(max_iter):
        dE = (E - e * math.sin(E) - M_rad) / (1 - e * math.cos(E))
        E -= dE
        if abs(dE) < tol:
            break
    return E


def heliocentric_position(elements: dict, T: float):
    """
    Bereken heliocentrische (x, y, z) positie in AU voor gegeven baanelementen
    op T Juliaanse eeuwen sinds J2000. Standaard vlak: ecliptica, X naar lentepunt,
    Z loodrecht op ecliptica (naar 'boven').
    """
    a = elements["a"][0] + elements["a"][1] * T
    e = elements["e"][0] + elements["e"][1] * T
    i = (elements["i"][0] + elements["i"][1] * T) * DEG2RAD
    L = (elements["L"][0] + elements["L"][1] * T)
    varpi = (elements["varpi"][0] + elements["varpi"][1] * T)
    Omega = (elements["Omega"][0] + elements["Omega"][1] * T)

    # gemiddelde anomalie
    M = (L - varpi) % 360.0
    if M > 180.0:
        M -= 360.0
    M_rad = M * DEG2RAD

    E = solve_kepler(M_rad, e)

    # positie in baanvlak (perifocaal)
    x_orb = a * (math.cos(E) - e)
    y_orb = a * math.sqrt(1 - e * e) * math.sin(E)

    omega_small = (varpi - Omega) * DEG2RAD  # argument van perihelium
    Omega_rad = Omega * DEG2RAD

    cos_o, sin_o = math.cos(omega_small), math.sin(omega_small)
    cos_O, sin_O = math.cos(Omega_rad), math.sin(Omega_rad)
    cos_i, sin_i = math.cos(i), math.sin(i)

    x = (cos_o * cos_O - sin_o * sin_O * cos_i) * x_orb + (-sin_o * cos_O - cos_o * sin_O * cos_i) * y_orb
    y = (cos_o * sin_O + sin_o * cos_O * cos_i) * x_orb + (-sin_o * sin_O + cos_o * cos_O * cos_i) * y_orb
    z = (sin_o * sin_i) * x_orb + (cos_o * sin_i) * y_orb

    return x, y, z


def moon_position_relative_to_earth(dt: datetime):
    """
    Sterk vereenvoudigd model van de maanbaan om de aarde (voldoende nauwkeurig
    voor visualisatie, niet voor navigatie). Retourneert (x, y, z) in AU,
    relatief t.o.v. de aarde, in hetzelfde ecliptica-referentiekader.
    """
    j2000 = datetime(2000, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    d = (dt - j2000).total_seconds() / 86400.0

    # gemiddelde lengte en anomalie van de maan (graden), benaderd (Meeus, afgekort)
    L = (218.316 + 13.176396 * d) % 360.0
    M = (134.963 + 13.064993 * d) % 360.0
    F = (93.272 + 13.229350 * d) % 360.0

    L_rad, M_rad, F_rad = L * DEG2RAD, M * DEG2RAD, F * DEG2RAD

    # geocentrische ecliptische lengte/breedte, eerste-orde correcties
    lon = L + 6.289 * math.sin(M_rad)
    lat = 5.128 * math.sin(F_rad)
    dist_km = 385001 - 20905 * math.cos(M_rad)

    lon_rad, lat_rad = lon * DEG2RAD, lat * DEG2RAD
    dist_au = dist_km / 149597870.7

    x = dist_au * math.cos(lat_rad) * math.cos(lon_rad)
    y = dist_au * math.cos(lat_rad) * math.sin(lon_rad)
    z = dist_au * math.sin(lat_rad)
    return x, y, z


@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/script.js")
def script_js():
    return send_from_directory(".", "script.js", mimetype="application/javascript")


@app.route("/api/positions")
def positions():
    t_param = request.args.get("t")
    if t_param:
        try:
            dt = datetime.fromisoformat(t_param.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            dt = datetime.now(timezone.utc)
    else:
        dt = datetime.now(timezone.utc)

    T = julian_centuries_since_j2000(dt)

    bodies = []
    earth_xyz = None

    for name in PLANET_ORDER:
        el = ORBITAL_ELEMENTS[name]
        x, y, z = heliocentric_position(el, T)
        body = {
            "name": name,
            "x": x, "y": y, "z": z,
            "radius_km": el["radius_km"],
            "color": el["color"],
            "period_days": el["period_days"],
            "has_rings": el.get("has_rings", False),
        }
        bodies.append(body)
        if name == "aarde":
            earth_xyz = (x, y, z)

    # Maan: positie t.o.v. aarde
    if earth_xyz:
        mx, my, mz = moon_position_relative_to_earth(dt)
        bodies.append({
            "name": "maan",
            "x": earth_xyz[0] + mx,
            "y": earth_xyz[1] + my,
            "z": earth_xyz[2] + mz,
            "radius_km": 1737.4,
            "color": [0xc8, 0xc8, 0xc8],
            "period_days": 27.32,
            "has_rings": False,
            "orbits": "aarde",
        })

    return jsonify({
        "timestamp": dt.isoformat(),
        "sun_radius_km": SUN_RADIUS_KM,
        "bodies": bodies,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3333, debug=False)
