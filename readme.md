# Subtitle Generator and API

Automatically generate subtitles from an input audio or video file using Open AI Whisper.

## 🚀 Try it instantly with Eyevinn Open Source Cloud

**Skip the setup and start generating subtitles immediately!** The Subtitle Generator is available as a fully managed service in [Eyevinn Open Source Cloud](https://docs.osaas.io/osaas.wiki/Service%3A-Subtitle-Generator.html).

[![Badge OSC](https://img.shields.io/badge/Evaluate-24243B?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyKSIvPgo8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBzdHJva2U9ImJsYWNrIiBzdHJva2Utd2lkdGg9IjIiLz4KPGRlZnM%2BCjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyIiB4MT0iMTIiIHkxPSIwIiB4Mj0iMTIiIHkyPSIyNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjQzE4M0ZGIi8%2BCjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzREQzlGRiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM%2BCjwvc3ZnPgo%3D)](https://app.osaas.io/browse/eyevinn-auto-subtitles)

### Why choose the managed service?

- **🎯 Zero setup required** - No need to install FFmpeg, manage OpenAI API keys, or configure AWS
- **⚡ Production-ready infrastructure** - Scalable, reliable subtitle generation at enterprise scale
- **🛠️ Professional support** - Real-time support in our [Slack workspace](https://slack.osaas.io/)
- **📊 Multiple formats** - Generate SRT, VTT, and other subtitle formats
- **🌍 Multi-language support** - Process content in multiple languages with OpenAI Whisper
- **🔒 Secure processing** - Your content is processed securely with industry-standard practices

Perfect for video streaming platforms, broadcast content, accessibility improvements, and multilingual content creation. [Check pricing](https://docs.osaas.io/osaas.wiki/Pricing.html) and get started in minutes.

---

**Prefer to self-host?** Continue reading to set up your own instance.

## Features

- Transcribe and translate audio to generate subtitle files (translation limited to English).
- Split large files into audio chunks to handle 25 MB file size limit and keeps track of timing information.
- Combines all segments with correct timecodes.
- Supports different output formats (VTT, SRT, JSON, text)
- Maintain context and improve continuity between chunks by giving Whisper some context about what was transcribed in the previous chunk.
- Produce more professional-looking subtitles that are easier to read and follow industry standards for broadcast and streaming platforms:
  - Characters per line limit for better readability
  - Appropriate duration based on text length
  - Natural line breaks at logical points
  - Minimum duration to ensure readability
  - Maximum duration to maintain attention

## Setup

### Requirements

The following environment variables can be set:

```text
OPENAI_API_KEY=<your-openapi-api-key>
AWS_REGION=<your-aws-region> (optional can also be provided in payload)
AWS_ACCESS_KEY_ID=<your-aws-access-key-id> (optional, only needed when uploading to S3)
AWS_SECRET_ACCESS_KEY=<your-aws-secret-access-key> (optional, only needed when uploading to S3)
AWS_S3_ENDPOINT=<aws-s3-endpoint> (optional)
```

Using an `.env` file is supported. Just rename `.env.example` to `.env` and insert your values.

### FFmpeg

FFmpeg is required to convert the input file/url to a format that Open AI Whisper can process. You can download it from [here](https://www.ffmpeg.org/download.html).

## Installation / Usage

Starting the service is as simple as running:

```bash
npm install
npm start
```

A docker image and docker-compose are also available:

```bash
docker-compose up --build -d
```

The transcribe service is now up and running and available on port `8000`.

### Endpoints

Available endpoints are:

| Endpoint         | Method | Description                                         |
| ---------------- | ------ | --------------------------------------------------- |
| `/`              | `GET`  | Heartbeat endpoint of service                       |
| `/transcribe`    | `POST` | Create a new transcribe job. Provide url in body    |
| `/transcribe/s3` | `POST` | Create a new transcribe job and upload result to s3 |

## Example requests

To start a new transcribe job send a `POST` request to the `/transcribe` endpoint with :

```jsonc
{
  "url": "https://example.net/vod-audio_en=128000.aac",
  "language": "en", // ISO 639-1 language code (https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) (optional)
  "format": "vtt" // Supported formats: srt or vtt (default)
}
```

The response will look like this where result is the `WEBVTT` file as a string:

```json
{
  "workerId": "BFabbcCi3IYuWOj6LfsgK",
  "result": "WEBVTT\n\n00:00:00.000 --> 00:00:04.180\nor into transcoding I mean, I could probably add just the keyframe in the start and just\n\n00:00:04.180 --> 00:00:06.920\nskip I-frames and the rest of that.\n\n"
}
```

Formatted output:

```text
WEBVTT

00:00:00.000 --> 00:00:01.940
So into transcoding, I mean, I could

00:00:01.940 --> 00:00:03.700
probably add just a keyframe in the start

00:00:03.700 --> 00:00:06.700
and then just skip iFrames in the rest of the scenes.
```

### Contributing

See [contributing](contributing.md)

## Support

Join our [community on Slack](http://slack.streamingtech.se) where you can post any questions regarding any of our open source projects. Eyevinn's consulting business can also offer you:

- Further development of this component
- Customization and integration of this component into your platform
- Support and maintenance agreement

Contact [sales@eyevinn.se](mailto:sales@eyevinn.se) if you are interested.

## About Eyevinn Technology

[Eyevinn Technology](https://www.eyevinntechnology.se) is an independent consultant firm specialized in video and streaming. Independent in a way that we are not commercially tied to any platform or technology vendor. As our way to innovate and push the industry forward we develop proof-of-concepts and tools. The things we learn and the code we write we share with the industry in [blogs](https://dev.to/video) and by open sourcing the code we have written.

Want to know more about Eyevinn and how it is to work here. Contact us at <work@eyevinn.se>!
