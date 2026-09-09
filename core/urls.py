from django.urls import path

from .views import HubView, MetronomeView, TrainerView, CirclesView

urlpatterns = [
    path('', HubView.as_view(), name='hub'),
    path('metronome/', MetronomeView.as_view(), name='metronome'),
    path('trainer/', TrainerView.as_view(), name='trainer'),
    path('circles/', CirclesView.as_view(), name='circles'),
]
