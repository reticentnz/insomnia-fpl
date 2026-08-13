#!/usr/bin/env python3
import json
import sys

from youtube_transcript_api import (
    YouTubeTranscriptApi,
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: fetch-youtube-transcript.py VIDEO_ID")
    video_id = sys.argv[1]
    try:
        transcript = YouTubeTranscriptApi().fetch(video_id, languages=["en", "en-GB", "en-US"])
        print(json.dumps({
            "status": "ok",
            "videoId": video_id,
            "language": transcript.language,
            "languageCode": transcript.language_code,
            "isGenerated": transcript.is_generated,
            "segments": transcript.to_raw_data(),
        }, ensure_ascii=False))
    except (NoTranscriptFound, TranscriptsDisabled, VideoUnavailable) as error:
        print(json.dumps({"status": "unavailable", "videoId": video_id, "reason": type(error).__name__, "error": str(error)}))
    except Exception as error:
        print(json.dumps({"status": "retry", "videoId": video_id, "reason": type(error).__name__, "error": str(error)}))


if __name__ == "__main__":
    main()
