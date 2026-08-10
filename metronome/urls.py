"""Root URL configuration for the metronome project."""
from django.urls import include, path

urlpatterns = [
    path('', include('core.urls')),
]