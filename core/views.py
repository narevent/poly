from django.views.generic import TemplateView


class HubView(TemplateView):
    """The Poly launcher — pick one of the apps."""

    template_name = 'poly/hub.html'


class MetronomeView(TemplateView):
    template_name = 'poly/metronome.html'


class TrainerView(TemplateView):
    template_name = 'poly/trainer.html'
