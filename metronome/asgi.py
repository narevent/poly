"""
ASGI config for the metronome project.
"""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'metronome.settings')

application = get_asgi_application()