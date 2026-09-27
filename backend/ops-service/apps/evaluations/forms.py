from django import forms
from django.contrib.auth.forms import AuthenticationForm

from .services import DATASET_ID, DATASET_LABEL


class OperatorAuthenticationForm(AuthenticationForm):
    def confirm_login_allowed(self, user):
        super().confirm_login_allowed(user)
        if not user.is_staff:
            raise forms.ValidationError("운영자 계정으로 로그인해 주세요.", code="not_operator")


class EvaluationForm(forms.Form):
    request_id = forms.UUIDField(widget=forms.HiddenInput)
    dataset_id = forms.ChoiceField(label="평가 자료", choices=[(DATASET_ID, DATASET_LABEL)])
