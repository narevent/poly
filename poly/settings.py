"""
Django settings for the Poly project.

Deployment values (SECRET_KEY, DEBUG, ALLOWED_HOSTS, DOMAIN) are read from
environment variables prefixed with POLY_ — these are written to
`.env` by scripts/init_vps.sh and loaded into the gunicorn unit via
EnvironmentFile. Locally, sensible dev defaults apply when the vars are
absent, so `python manage.py runserver` works out of the box.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _env_bool(name: str, default: bool = False) -> bool:
    """Read a truthy env var: 1/true/yes/on (case-insensitive) → True."""
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


# --- Security / runtime config (env-driven) --------------------------------
# In production these come from .env (see scripts/init_vps.sh). Locally we fall
# back to a dev key and DEBUG=True so runserver is frictionless.

SECRET_KEY = os.environ.get(
    "POLY_SECRET_KEY",
    "django-insecure-change-me-in-production-please",
)

DEBUG = _env_bool("POLY_DEBUG", default=True)

ALLOWED_HOSTS = [
    h for h in (
        os.environ.get("POLY_ALLOWED_HOSTS", "").split(",")
    ) if h
] or ["localhost", "127.0.0.1", "0.0.0.0"]

# Domain the site is served on (used for absolute URLs / CSRF_TRUSTED_ORIGINS).
DOMAIN = os.environ.get("POLY_DOMAIN", "localhost")

# When DEBUG is False, Django requires SECURE settings to be consistent with
# the proxy. Allow the X-Forwarded-Proto header nginx sets so https is detected.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

CSRF_TRUSTED_ORIGINS = [f"https://{DOMAIN}"] if DOMAIN != "localhost" else []


INSTALLED_APPS = [
    'django.contrib.staticfiles',
    'core',
]

MIDDLEWARE = [
    'django.middleware.common.CommonMiddleware',
]

ROOT_URLCONF = 'poly.urls'

WSGI_APPLICATION = 'poly.wsgi.application'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [],
        },
    },
]

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    }
}

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'