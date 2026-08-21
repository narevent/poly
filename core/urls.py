from django.urls import path

from .views import HubView, MetronomeView, TrainerView

urlpatterns = [
    path('', HubView.as_view(), name='hub'),
    path('metronome/', MetronomeView.as_view(), name='metronome'),
    path('trainer/', TrainerView.as_view(), name='trainer'),
]
