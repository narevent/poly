"""
WSGI config for the metronome project.
"""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'metronome.settings')

application = get_wsgi_application()