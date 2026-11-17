# Overview
It will be a voicebot which will be listening to user voice through laptop microphone.

# Flow
- Bot listens to user through the microphone. Use voice activity detection module
- It captures audio chunks and send it in stream it to backend hosted at `VITE_WS_BASE_URL`. Format
```json
{
    "type": "user_audio",
    "audio_record_start_timestamp in yyyy-mm-dd HH:MM:SS": "audio chunk bytes1"
}
```
Then
```json
{
    "type": "user_audio",
    "audio_record_start_timestamp in yyyy-mm-dd HH:MM:SS": "audio chunk bytes2"
}
```

On speech end send flag speech_end = True to backend. Else send speech_end = False as long as user is speaking
