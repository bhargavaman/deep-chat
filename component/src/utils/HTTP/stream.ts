import {EventSourceMessage, fetchEventSource} from '@microsoft/fetch-event-source';
import {ServiceIO, StreamHandlers} from '../../services/serviceIO';
import {OpenAIConverseResult} from '../../types/openAIResult';
import {ErrorMessages} from '../errorMessages/errorMessages';
import {Messages} from '../../views/chat/messages/messages';
import {RequestUtils} from './requestUtils';
import {Result} from '../../types/result';
import {Demo} from '../demo/demo';

type SimulationSH = Omit<StreamHandlers, 'abortStream'> & {abortStream: {abort: () => void}};

export class Stream {
  public static request(io: ServiceIO, body: object, messages: Messages, stringifyBody = true) {
    const requestDetails = {body, headers: io.requestSettings?.headers};
    const {body: interceptedBody, headers: interceptedHeaders} =
      io.deepChat.requestInterceptor?.(requestDetails) || requestDetails;
    if (io.requestSettings?.url === Demo.URL) return Demo.requestStream(messages, io.streamHandlers);
    const {onOpen, onClose, abortStream} = io.streamHandlers;
    let textElement: HTMLElement | null = null;
    fetchEventSource(io.requestSettings?.url || io.url || '', {
      method: io.requestSettings?.method || 'POST',
      headers: interceptedHeaders,
      body: stringifyBody ? JSON.stringify(interceptedBody) : interceptedBody,
      openWhenHidden: true, // keep stream open when browser tab not open
      async onopen(response: Response) {
        if (response.ok) {
          textElement = messages.addNewStreamedMessage();
          return onOpen();
        }
        const result = await RequestUtils.processResponseByType(response);
        throw result;
      },
      onmessage(message: EventSourceMessage) {
        if (JSON.stringify(message.data) !== JSON.stringify('[DONE]')) {
          const response = JSON.parse(message.data) as unknown as OpenAIConverseResult;
          io.extractResultData?.(response)
            .then((textBody?: Result) => {
              if (textBody?.text === undefined) {
                // strategy - do not to stop the stream on one message failure to give other messages a change to display
                console.error(`Response data: ${message.data} \n ${ErrorMessages.INVALID_STREAM_RESPONSE}`);
              } else if (textElement) messages.updateStreamedMessage(textBody.text, textElement);
            })
            .catch((e) => RequestUtils.displayError(messages, e));
        }
      },
      onerror(err) {
        onClose();
        throw err; // need to throw otherwise stream will retry infinitely
      },
      onclose() {
        messages.finaliseStreamedMessage();
        onClose();
      },
      signal: abortStream.signal,
    }).catch((err) => {
      // allowing extractResultData to attempt extract error message and throw it
      io.extractResultData?.(err)
        .then(() => {
          RequestUtils.displayError(messages, err);
        })
        .catch((parsedError) => {
          RequestUtils.displayError(messages, parsedError);
        });
    });
  }

  public static simulate(messages: Messages, sh: StreamHandlers, text?: string) {
    const simulationSH = sh as unknown as SimulationSH;
    const responseText = text?.split(' ') || [];
    const timeout = setTimeout(() => {
      const textElement = messages.addNewStreamedMessage();
      sh.onOpen();
      Stream.populateMessages(textElement, responseText, messages, simulationSH);
    }, 400);
    simulationSH.abortStream.abort = () => Stream.abort(timeout, messages, simulationSH.onClose);
  }

  // prettier-ignore
  private static populateMessages(
      textEl: HTMLElement, responseText: string[], messages: Messages, sh: SimulationSH, wordIndex = 0) {
    const timeout = setTimeout(() => {
      const word = responseText[wordIndex];
      if (word) {
        messages.updateStreamedMessage(`${word} `, textEl);
        Stream.populateMessages(textEl, responseText, messages, sh, wordIndex + 1);
      } else {
        messages.finaliseStreamedMessage();
        sh.onClose();
      }
    }, 70);
    sh.abortStream.abort = () => Stream.abort(timeout, messages, sh.onClose);
  }

  private static abort(timeout: number, messages: Messages, onClose: () => void) {
    clearTimeout(timeout);
    messages.finaliseStreamedMessage();
    onClose();
  }
}