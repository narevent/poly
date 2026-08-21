# Poly

Two rhythm tools behind one launcher, served by a small Django app.

| Screen | Path | What it is |
| --- | --- | --- |
| Hub | `/` | Pick an app. |
| Metronome | `/metronome/` | Stack layers at any meter and subdivision; save presets, chain them into a song. |
| Trainer | `/trainer/` | Tap both voices of a polyrhythm at once; every hit scored to the millisecond. |

Both apps carry a `● Poly` lockup in the top-left that links back to the hub.

## Project structure

```
poly/                       # Django project (config) package
├── settings.py             # env-driven, prefix POLY_
├── urls.py  wsgi.py  asgi.py
core/                       # the Django app serving all three screens
├── views.py                # HubView · MetronomeView · TrainerView
├── urls.py
├── templates/poly/
│   ├── base.html           # <head>, fonts, tokens — every screen extends this
│   ├── hub.html
│   ├── metronome.html
│   └── trainer.html
└── static/poly/
    ├── shared/             # what more than one screen uses
    │   ├── tokens.css      #   colour, type, spacing, the brand lockup
    │   ├── components.css  #   shell, transport, buttons, fields, status bar
    │   └── voices.js       #   the sound library BOTH apps play through
    ├── hub/hub.css
    ├── metronome/          # styles.css + js/{app,audio,store,claves}.js
    └── trainer/            # trainer.css + js/trainer.js
```

The rule for `shared/`: something moves there the moment a **second** screen
needs it, so the apps cannot drift apart by accident. Anything only one app
uses stays in that app's folder.

Adding a third app is: a template extending `poly/base.html`, a folder under
`static/poly/`, a view, a URL, and one more `<a class="app-card">` on the hub —
the hub's grid re-divides on its own.

## Run

```bash
python manage.py runserver
```

Then open http://127.0.0.1:8000/

All state (layers, presets, songs, trainer settings and best streak) is stored
client-side in localStorage, so there are no models and no migrations. The two
apps use separate keys — `poly-metronome-v2` and `poly-trainer-v1`.

## Deployment

`scripts/` derives every path, user and service name from `$PROJECT`. The
Django-side names it needs are set in `scripts/config.sh`:
`DJANGO_PKG=poly` and `ENV_PREFIX=POLY` (so `POLY_SECRET_KEY`,
`POLY_DEBUG`, `POLY_ALLOWED_HOSTS`, `POLY_DOMAIN`).
