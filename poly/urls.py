"""Root URL configuration for the Poly project."""
from django.urls import include, path

urlpatterns = [
    path('', include('core.urls')),
]