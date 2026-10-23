"""Windows-side bridge between the signage Worker and OBS WebSocket v5."""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests
from obswebsocket import obsws, requests as obs_requests


API_BASE_URL = os.environ.get(
    "SIGNAGE_API_URL", "https://shikosai-signage-api.shikosai.workers.dev"
).rstrip("/")
AGENT_TOKEN = os.environ.get("SIGNAGE_OBS_AGENT_TOKEN", "")
OBS_HOST = os.environ.get("OBS_WEBSOCKET_HOST", "127.0.0.1")
OBS_PORT = int(os.environ.get("OBS_WEBSOCKET_PORT", "4455"))
OBS_PASSWORD = os.environ.get("OBS_WEBSOCKET_PASSWORD", "")
OBS_SCENE = os.environ.get("OBS_SCENE_NAME", "シーン")
OBS_STAGE_SOURCE = os.environ.get("OBS_STAGE_SOURCE", "ステージ映像")
OBS_CM_SOURCE = os.environ.get("OBS_CM_SOURCE", "CM映像")
OBS_TITLE_SOURCE = os.environ.get("OBS_TITLE_SOURCE", "telop")
OBS_NEXT_SOURCE = os.environ.get("OBS_NEXT_SOURCE", "次企画")
OBS_NOTICE_LEFT_SOURCE = os.environ.get("OBS_NOTICE_LEFT_SOURCE", "お知らせ 左")
OBS_NOTICE_RIGHT_SOURCE = os.environ.get("OBS_NOTICE_RIGHT_SOURCE", "お知らせ 右")
OBS_CIRCLE_NAME_SOURCE = os.environ.get("OBS_CIRCLE_NAME_SOURCE", "サークル名")
OBS_CIRCLE_DESCRIPTION_SOURCE = os.environ.get("OBS_CIRCLE_DESCRIPTION_SOURCE", "サークル説明")
OBS_CIRCLE_IMAGE_SOURCE = os.environ.get("OBS_CIRCLE_IMAGE_SOURCE", "サークルカット")
OBS_CLOCK_SOURCE = os.environ.get("OBS_CLOCK_SOURCE", "時計")
CM_FOLDER = Path(
    os.environ.get("SIGNAGE_CM_FOLDER", str(Path(__file__).resolve().parent / "CM"))
).expanduser().resolve()

API_HEADERS = {"User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0"}
if AGENT_TOKEN:
    API_HEADERS["X-OBS-Agent-Token"] = AGENT_TOKEN

logging.basicConfig(
    level=os.environ.get("SIGNAGE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
LOG = logging.getLogger("shikosai-obs-agent")


class ObsAgent:
    def __init__(self) -> None:
        self.ws: obsws | None = None
        self.session = requests.Session()
        self.session.headers.update(API_HEADERS)
        self.scene_items: dict[str, int | None] = {}
        self.active_program_id: int | None = None
        self.active_program_title = ""
        self.active_program_text = ""
        self.active_ad: dict[str, Any] | None = None
        self.break_key = ""
        self.skipped_ads: set[int] = set()
        self.last_heartbeat = 0.0
        self.last_error = ""
        self.text_values: dict[str, str] = {}
        self.notice_index = -1
        self.notice_changed_at = 0.0

    def connect(self) -> None:
        self.ws = obsws(OBS_HOST, OBS_PORT, OBS_PASSWORD)
        self.ws.connect()
        self.text_values.clear()
        self.active_program_id = None
        self.active_program_text = ""
        if self.active_ad:
            self.skipped_ads.add(int(self.active_ad["id"]))
            self.active_ad = None
        self.refresh_scene_items()
        LOG.info("OBS connected at %s:%s, scene=%s", OBS_HOST, OBS_PORT, OBS_SCENE)

    def disconnect(self) -> None:
        if self.ws:
            try:
                self.ws.disconnect()
            except Exception:
                LOG.debug("OBS disconnect failed", exc_info=True)

    def refresh_scene_items(self) -> None:
        if not self.ws:
            return
        for name in (OBS_STAGE_SOURCE, OBS_CM_SOURCE, OBS_TITLE_SOURCE):
            try:
                result = self.ws.call(
                    obs_requests.GetSceneItemId(sceneName=OBS_SCENE, sourceName=name)
                )
                self.scene_items[name] = result.getSceneItemId()
            except Exception:
                self.scene_items[name] = None
                LOG.warning("OBS source not found: %s (scene %s)", name, OBS_SCENE)

    def set_visible(self, source: str, visible: bool) -> None:
        item_id = self.scene_items.get(source)
        if self.ws and item_id is not None:
            self.ws.call(
                obs_requests.SetSceneItemEnabled(
                    sceneName=OBS_SCENE,
                    sceneItemId=item_id,
                    sceneItemEnabled=visible,
                )
            )

    def set_title(self, value: str) -> None:
        self.set_text(OBS_TITLE_SOURCE, value)

    def set_text(self, source: str, value: str) -> None:
        if not self.ws or self.text_values.get(source) == value:
            return
        try:
            self.ws.call(
                obs_requests.SetInputSettings(
                    inputName=source,
                    inputSettings={"text": value},
                )
            )
            self.text_values[source] = value
        except Exception as error:
            LOG.warning("OBS text source could not be updated (%s): %s", source, error)

    def split_notice(self, value: str) -> tuple[str, str]:
        chars = list(value)
        if len(chars) <= 90:
            return value, ""
        midpoint = min(100, len(chars) // 2)
        low = max(35, midpoint - 25)
        high = min(len(chars), midpoint + 25)
        for index in range(midpoint, low - 1, -1):
            if chars[index - 1] in "。！？!?、 \n":
                midpoint = index
                break
        else:
            for index in range(midpoint + 1, high + 1):
                if chars[index - 1] in "。！？!?、 \n":
                    midpoint = index
                    break
        return "".join(chars[:midpoint]).strip(), "".join(chars[midpoint:]).strip()

    def update_circle_image(self, circle: dict[str, Any] | None) -> None:
        if not self.ws:
            return
        image_url = str((circle or {}).get("circle_cut_path") or "")
        if not image_url.startswith(("https://", "http://")):
            image_url = ""
        if self.text_values.get(f"image:{OBS_CIRCLE_IMAGE_SOURCE}") == image_url:
            return
        try:
            self.ws.call(
                obs_requests.SetInputSettings(
                    inputName=OBS_CIRCLE_IMAGE_SOURCE,
                    inputSettings={"url": image_url},
                )
            )
            self.text_values[f"image:{OBS_CIRCLE_IMAGE_SOURCE}"] = image_url
        except Exception as error:
            LOG.warning("OBS circle image source could not be updated (%s): %s", OBS_CIRCLE_IMAGE_SOURCE, error)

    def apply_obs_content(self, playback: dict[str, Any]) -> None:
        next_program = playback.get("next") or {}
        sidebar = playback.get("sidebar") or {}
        notices = playback.get("notices") or []
        now = time.monotonic()

        if notices and (self.notice_index < 0 or now - self.notice_changed_at >= 10):
            self.notice_index = (self.notice_index + 1) % len(notices)
            self.notice_changed_at = now
        if notices:
            notice = notices[self.notice_index % len(notices)]
            left, right = self.split_notice(str(notice.get("text") or ""))
            label = "【緊急】" if notice.get("is_emergency") else f"【{notice.get('category') or 'お知らせ'}】"
            self.set_text(OBS_NOTICE_LEFT_SOURCE, f"{label}{left}")
            self.set_text(OBS_NOTICE_RIGHT_SOURCE, right)
        else:
            self.set_text(OBS_NOTICE_LEFT_SOURCE, "")
            self.set_text(OBS_NOTICE_RIGHT_SOURCE, "")

        next_text = ""
        if next_program:
            start = next_program.get("adjusted_start") or next_program.get("scheduled_start") or ""
            next_text = " · ".join(part for part in (f"次の企画 {start}".strip(), next_program.get("title", ""), next_program.get("class_name", "")) if part)
        self.set_text(OBS_NEXT_SOURCE, next_text)
        self.set_text(OBS_CIRCLE_NAME_SOURCE, str(sidebar.get("name") or ""))
        self.set_text(OBS_CIRCLE_DESCRIPTION_SOURCE, str(sidebar.get("description") or sidebar.get("program_description") or ""))
        self.update_circle_image(sidebar)
        self.set_text(OBS_CLOCK_SOURCE, str(playback.get("now") or ""))

    def media_state(self) -> str:
        if not self.ws:
            return ""
        try:
            result = self.ws.call(obs_requests.GetMediaInputStatus(inputName=OBS_CM_SOURCE))
            return str(result.getMediaState() or "")
        except Exception:
            return ""

    def resolve_media_path(self, media_path: str) -> Path:
        candidate = (CM_FOLDER / media_path).resolve()
        if not candidate.is_relative_to(CM_FOLDER):
            raise ValueError("CMパスは設定済みフォルダの中を指定してください")
        if not candidate.is_file():
            raise FileNotFoundError(f"配信PCにCMファイルがありません: {media_path}")
        return candidate

    def start_ad(self, ad: dict[str, Any], break_key: str) -> None:
        media_path = self.resolve_media_path(str(ad.get("media_path", "")))
        if not self.ws:
            raise RuntimeError("OBSに接続されていません")
        self.ws.call(
            obs_requests.SetInputSettings(
                inputName=OBS_CM_SOURCE,
                inputSettings={"local_file": str(media_path), "looping": False},
            )
        )
        self.ws.call(
            obs_requests.TriggerMediaInputAction(
                inputName=OBS_CM_SOURCE,
                mediaAction="OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
            )
        )
        self.set_visible(OBS_STAGE_SOURCE, False)
        self.set_visible(OBS_CM_SOURCE, True)
        self.set_visible(OBS_TITLE_SOURCE, False)
        self.active_ad = ad
        self.break_key = break_key
        LOG.info("CM started in OBS: %s (%s)", ad.get("title", ""), media_path.name)

    def finish_ad(self) -> None:
        if not self.active_ad:
            return
        ad = self.active_ad
        break_key = self.break_key
        self.active_ad = None
        try:
            response = self.session.post(
                f"{API_BASE_URL}/api/commercials/{quote(str(ad['id']))}/play",
                params={"break": break_key},
                timeout=5,
            )
            response.raise_for_status()
            LOG.info("CM completed: %s", ad.get("title", ""))
        except requests.RequestException:
            LOG.exception("Could not save CM playback history")

    def activate_program(self, program: dict[str, Any]) -> None:
        if self.active_ad:
            self.active_ad = None
            try:
                self.ws.call(
                    obs_requests.TriggerMediaInputAction(
                        inputName=OBS_CM_SOURCE,
                        mediaAction="OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP",
                    )
                )
            except Exception:
                pass
        program_id = int(program.get("id", -1))
        title = str(program.get("title") or "")
        group = str(program.get("class_name") or "")
        description = str(program.get("description") or "")
        display_text = " / ".join(part for part in (title, group, description) if part)
        is_new_program = self.active_program_id != program_id
        if is_new_program:
            self.set_visible(OBS_CM_SOURCE, False)
            self.set_visible(OBS_STAGE_SOURCE, True)
            self.set_visible(OBS_TITLE_SOURCE, True)
        if self.active_program_text != display_text:
            self.set_title(display_text)
            self.active_program_text = display_text
        self.active_program_id = program_id
        self.active_program_title = title
        if is_new_program:
            LOG.info("OBS stage program: %s", title)

    def activate_break(self, playback: dict[str, Any]) -> None:
        if self.active_program_id is not None:
            self.active_program_id = None
            self.active_program_title = ""
            self.set_visible(OBS_STAGE_SOURCE, False)
            self.set_visible(OBS_TITLE_SOURCE, False)
        break_key = str(playback.get("break_key") or "")
        if self.break_key != break_key:
            self.break_key = break_key
            self.skipped_ads.clear()
        if self.active_ad:
            state = self.media_state()
            if state == "OBS_MEDIA_STATE_PLAYING":
                return
            if state == "OBS_MEDIA_STATE_ENDED":
                self.finish_ad()
                return
            else:
                self.skipped_ads.add(int(self.active_ad["id"]))
                LOG.warning("CM stopped before completion: %s", self.active_ad.get("title", ""))
                self.active_ad = None

        candidates = playback.get("playlist") or []
        ad = next(
            (item for item in candidates if int(item.get("id", -1)) not in self.skipped_ads),
            None,
        )
        if not ad:
            self.set_visible(OBS_CM_SOURCE, False)
            return
        if self.active_ad is None:
            try:
                self.start_ad(ad, break_key)
            except (OSError, ValueError, RuntimeError) as error:
                self.skipped_ads.add(int(ad.get("id", -1)))
                self.last_error = str(error)
                LOG.error("CM could not be started: %s", error)

    def handle_state(self, result: dict[str, Any]) -> None:
        state = result.get("state") or {}
        playback = result.get("playback") or {}
        self.apply_obs_content(playback)
        current = playback.get("current")
        if current and current.get("kind") != "break":
            is_waiting_for_cm = bool(state.get("wait_cm")) and self.active_ad and self.media_state() == "OBS_MEDIA_STATE_PLAYING"
            if not is_waiting_for_cm:
                self.activate_program(current)
            return
        self.activate_break(playback)

    def send_heartbeat(self) -> None:
        if time.monotonic() - self.last_heartbeat < 5:
            return
        if not self.ws:
            return
        scene_name = ""
        result = self.ws.call(obs_requests.GetCurrentProgramScene())
        scene_name = str(result.getCurrentProgramSceneName() or "")
        payload = {
            "current_scene": scene_name,
            "current_program": self.active_program_title,
            "current_commercial": str((self.active_ad or {}).get("title", "")),
            "last_error": self.last_error,
        }
        response = self.session.post(f"{API_BASE_URL}/api/obs/heartbeat", json=payload, timeout=5)
        response.raise_for_status()
        self.last_heartbeat = time.monotonic()
        self.last_error = ""

    def run(self) -> None:
        LOG.info("OBS agent polling %s; CM folder: %s", API_BASE_URL, CM_FOLDER)
        try:
            while True:
                if not self.ws:
                    try:
                        self.connect()
                    except Exception as error:
                        self.last_error = f"OBS接続失敗: {error}"
                        LOG.warning("OBS connection error: %s", error)
                        time.sleep(5)
                        continue
                try:
                    response = self.session.get(f"{API_BASE_URL}/api/state", timeout=5)
                    response.raise_for_status()
                    data = response.json()
                    self.handle_state(data)
                    self.send_heartbeat()
                except requests.RequestException as error:
                    self.last_error = str(error)
                    LOG.warning("Worker connection error: %s", error)
                except Exception as error:
                    self.last_error = str(error)
                    LOG.exception("OBS agent cycle failed")
                    self.disconnect()
                    self.ws = None
                time.sleep(1)
        finally:
            self.disconnect()


if __name__ == "__main__":
    ObsAgent().run()
