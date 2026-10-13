import os
from importlib import import_module

from django.conf import settings
from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
application = get_wsgi_application()
# 첫 관리자 요청이 URL·view 모듈 초기화를 기다리지 않도록 worker 시작 중 완료한다.
import_module(settings.ROOT_URLCONF)
