#!/bin/sh
# git "clean" 필터: 작업 트리 -> git에 저장될 때 실행된다.
# manifest.json의 oauth2.client_id 실제 값을 플레이스홀더로 치환해서,
# 실제 OAuth client_id가 git 이력에 절대 들어가지 않도록 한다.
sed -E 's/("client_id": *")[^"]+(")/\1YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com\2/'
