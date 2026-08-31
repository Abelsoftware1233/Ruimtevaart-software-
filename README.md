# Zonnestelsel — Live 3D

## Lokaal testen

```bash
pip install flask
python3 app.py
```

Open daarna: **http://localhost:3333**

## Deployen op een server (venv + systemd)

Zet alle bestanden (`app.py`, `index.html`, `script.js`, `deploy.sh`) samen in
een map op de server en draai:

```bash
sudo ./deploy.sh
```

Dit doet het volgende:
- plaatst de app in `/opt/melkweg`
- maakt een Python-venv aan in `/opt/melkweg/venv` en installeert Flask erin
- schrijft en activeert een systemd-service `melkweg.service` die de app
  op poort **3333** draait en automatisch herstart bij een crash of reboot

Nuttige commando's na deploy:
```bash
journalctl -u melkweg.service -f     # logs live volgen
sudo systemctl restart melkweg.service
sudo systemctl stop melkweg.service
```

Draai `sudo ./deploy.sh` opnieuw na code-wijzigingen — het script is idempotent
(update van bestanden, dependencies, en herstart van de service).

**Nginx** (reverse proxy naar `127.0.0.1:3333` + TLS voor
`melkweg.***********.com`) wordt hier bewust niet opgezet — dat regel je zelf.
Zorg dat de DNS van `melkweg.abelsoftware123.com` naar het IP van deze server wijst.

## Wat het doet

- De Python-backend (`app.py`) berekent de **actuele posities** van alle acht planeten
  en de maan met Kepler-baanelementen (J2000-epoch, standaard NASA/JPL-waarden).
  Dit werkt volledig offline — geen internet of externe API nodig.
- De frontend (`index.html` + `script.js`) toont dit als een echte 3D-scene met Three.js:
  - elke planeet in zijn eigen realistische kleur
  - een gloeiende zon met puntlicht
  - Saturnusringen
  - een sterrenveld op de achtergrond
  - de maan die om de aarde draait (visueel iets uitvergroot, anders onzichtbaar op deze schaal)
- Bedien de tijd met de schuifregelaar linksonder (0.25 tot 180 dagen per seconde),
  pauzeer/hervat, of spring terug naar "nu".
- Sleep om te draaien, scroll/knijp om te zoomen, klik op een planeet (of in de lijst
  rechtsboven) om erop in te zoomen en details te zien.

## Bestanden

- `app.py` — Flask-backend, serveert de pagina's en `/api/positions`
- `index.html` — pagina-structuur en styling
- `script.js` — Three.js 3D-rendering en besturing
