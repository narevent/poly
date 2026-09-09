from django.views.generic import TemplateView


class HubView(TemplateView):
    """The Poly launcher — pick one of the apps."""

    template_name = 'poly/hub.html'


class MetronomeView(TemplateView):
    template_name = 'poly/metronome.html'


class TrainerView(TemplateView):
    template_name = 'poly/trainer.html'


class CirclesView(TemplateView):
    template_name = 'poly/circles.html'


class AudioCheckView(TemplateView):
    """A diagnostic page: measures what the audio graph actually renders, so a
    dropout on someone else's phone can be read rather than guessed at."""

    template_name = 'poly/audio_check.html'
