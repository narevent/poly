# Metronome

A simple Django app wrapping the metronome webapp.

## Project structure

```
metronome/
├── manage.py
├── metronome/            # Django project (config) package
│   ├── __init__.py
│   ├── settings.py
│   ├── urls.py
│   ├── wsgi.py
│   └── asgi.py
└── core/                 # Django app serving the front-end
    ├── __init__.py
    ├── apps.py
    ├── views.py
    ├── urls.py
    ├── templates/
    │   └── metronome/
    │       └── index.html
    └── static/
        └── metronome/
            ├── styles.css
            └── js/
                └── *.js
```

The project package is named `metronome` (the config holding `settings.py`),
and the Django app is named `core`.

## Run

```bash
cd metronome
python manage.py runserver
```

Then open http://127.0.0.1:8000/

All metronome state is stored client-side (localStorage), so there are no
models or migrations.