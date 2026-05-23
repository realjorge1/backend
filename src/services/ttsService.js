const textToSpeech = require("@google-cloud/text-to-speech");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const util = require("util");
const { v4: uuidv4 } = require("uuid");

class TTSService {
  constructor() {
    // Initialize Google Cloud TTS client (if credentials available)
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      this.client = new textToSpeech.TextToSpeechClient();
      this.provider = "google";
    } else if (process.env.AZURE_SPEECH_KEY) {
      this.provider = "azure";
    } else if (process.env.AWS_ACCESS_KEY_ID) {
      this.provider = "aws";
    } else {
      this.provider = "none";
    }
  }

  /**
   * Convert text to speech using Google Cloud TTS
   */
  async textToSpeechGoogle(text, options = {}) {
    try {
      const request = {
        input: { text: text.slice(0, 5000) }, // Google limit: 5000 chars
        voice: {
          languageCode: options.language || "en-US",
          name: options.voiceName || "en-US-Standard-C",
          ssmlGender: options.gender || "NEUTRAL",
        },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: options.speed || 1.0,
          pitch: options.pitch || 0.0,
        },
      };

      const [response] = await this.client.synthesizeSpeech(request);
      return response.audioContent;
    } catch (error) {
      console.error("Google TTS error:", error);
      throw new Error("Failed to convert text to speech");
    }
  }

  /**
   * Convert text to speech using Azure Cognitive Services
   */
  async textToSpeechAzure(text, options = {}) {
    const sdk = require("microsoft-cognitiveservices-speech-sdk");

    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_SPEECH_REGION || "eastus",
    );

    speechConfig.speechSynthesisVoiceName =
      options.voiceName || "en-US-JennyNeural";

    // Use unique temp file per request to avoid race conditions
    const tempFile = path.join(os.tmpdir(), `tts-${uuidv4()}.mp3`);
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(tempFile);
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    return new Promise((resolve, reject) => {
      synthesizer.speakTextAsync(
        text,
        async (result) => {
          synthesizer.close();
          if (result) {
            try {
              const audioBuffer = await fs.readFile(tempFile);
              await fs.unlink(tempFile).catch(() => {});
              resolve(audioBuffer);
            } catch (err) {
              reject(err);
            }
          } else {
            await fs.unlink(tempFile).catch(() => {});
            reject(new Error("Speech synthesis failed"));
          }
        },
        async (error) => {
          synthesizer.close();
          await fs.unlink(tempFile).catch(() => {});
          reject(error);
        },
      );
    });
  }

  /**
   * Convert text to speech using AWS Polly
   */
  async textToSpeechAWS(text, options = {}) {
    const AWS = require("aws-sdk");

    const polly = new AWS.Polly({
      region: process.env.AWS_REGION || "us-east-1",
    });

    const params = {
      Text: text,
      OutputFormat: "mp3",
      VoiceId: options.voiceName || "Joanna",
      Engine: "neural",
    };

    const data = await polly.synthesizeSpeech(params).promise();
    return data.AudioStream;
  }

  /**
   * Convert PDF text to speech
   */
  async pdfToSpeech(pdfFile, options = {}) {
    try {
      // Extract text from PDF
      const { parsePDF } = require("../utils/pdfParser");
      const dataBuffer = await fs.readFile(pdfFile.tempFilePath);
      const data = await parsePDF(dataBuffer);

      const text = data.text.slice(0, 5000); // Limit for API

      // Convert to speech based on provider
      switch (this.provider) {
        case "google":
          return await this.textToSpeechGoogle(text, options);
        case "azure":
          return await this.textToSpeechAzure(text, options);
        case "aws":
          return await this.textToSpeechAWS(text, options);
        default:
          throw new Error(
            "No TTS provider configured. Set GOOGLE_APPLICATION_CREDENTIALS, AZURE_SPEECH_KEY, or AWS credentials.",
          );
      }
    } catch (error) {
      console.error("PDF to speech error:", error);
      throw error;
    }
  }

  /**
   * Get available voices
   */
  async getAvailableVoices() {
    switch (this.provider) {
      case "google":
        const [result] = await this.client.listVoices({});
        return result.voices;
      case "azure":
        return [
          "en-US-JennyNeural",
          "en-US-GuyNeural",
          "en-GB-SoniaNeural",
          "es-ES-ElviraNeural",
          "fr-FR-DeniseNeural",
        ];
      case "aws":
        return [
          "Joanna",
          "Matthew",
          "Ivy",
          "Justin",
          "Kendra",
          "Kimberly",
          "Salli",
          "Joey",
          "Kevin",
          "Nicole",
          "Russell",
          "Amy",
          "Brian",
          "Emma",
          "Aditi",
          "Raveena",
        ];
      default:
        return [];
    }
  }

  /**
   * Check if TTS is configured
   */
  isConfigured() {
    return this.provider !== "none";
  }

  /**
   * Get current provider
   */
  getProvider() {
    return this.provider;
  }
}

module.exports = new TTSService();
