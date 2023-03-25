# Subtitle Generator and API

Automatically generate subtitles from an input audio or video file using Open AI Whisper.

## Setup

### Requirements

The following environment variables can be set:
```text
OPENAI_API_KEY=<your-openapi-api-key>
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

| Endpoint                         | Method   | Description                                      |
| -------------------------------- | -------- | -------------------------------------------------|
| `/`                              | `GET`    | Heartbeat endpoint of service                    |
| `/transcribe`                    | `POST`   | Create a new transcribe job. Provide url in body |

## Example requests

To start a new transcribe job send a `POST` request to the `/transcribe` endpoint with :

```json
{
  "url": "https://example.net/vod-audio_en=128000.aac"
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

00: 00: 00.000 --> 00: 00: 01.940
So into transcoding, I mean, I could

00: 00: 01.940 --> 00: 00: 03.700
probably add just a keyframe in the start

00: 00: 03.700 --> 00: 00: 06.700
and then just skip iFrames in the rest of the scenes.
```

### Contributing

See [CONTRIBUTING](CONTRIBUTING.md)

# Support

Join our [community on Slack](http://slack.streamingtech.se) where you can post any questions regarding any of our open source projects. Eyevinn's consulting business can also offer you:

- Further development of this component
- Customization and integration of this component into your platform
- Support and maintenance agreement

Contact [sales@eyevinn.se](mailto:sales@eyevinn.se) if you are interested.

# About Eyevinn Technology

[Eyevinn Technology](https://www.eyevinntechnology.se) is an independent consultant firm specialized in video and streaming. Independent in a way that we are not commercially tied to any platform or technology vendor. As our way to innovate and push the industry forward we develop proof-of-concepts and tools. The things we learn and the code we write we share with the industry in [blogs](https://dev.to/video) and by open sourcing the code we have written.

Want to know more about Eyevinn and how it is to work here. Contact us at work@eyevinn.se!
