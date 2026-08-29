/**
 * Um 206 mais curto que o pedido: o arquivo acabou, ou o host está partido?
 *
 * As duas coisas parecem iguais no corpo da resposta e são opostas no que
 * significam, e distingui-las custou um bug de produto inteiro. O visualizador
 * pede os primeiros 8 KiB de todo COPC para lhe ler o cabeçalho; um ladrilho de
 * umas centenas de pontos é menor que isso, e a resposta CORRETA a esse pedido
 * — 206 com o arquivo todo — era lida como "o host não suporta Range". Como o
 * carregamento de um projeto é um `Promise.all`, um ladrilho pequeno derrubava
 * todas as outras camadas com ele: o projeto não abria.
 *
 * A prova que separa os dois casos é o `Content-Range` da própria origem. Estes
 * testes existem sobretudo para o CASO NEGATIVO — um host que devolve menos do
 * que o arquivo tem continua a ser um erro, e afrouxar isso teria trocado um
 * bug visível por corrupção silenciosa no decodificador.
 */
import { describe, expect, it } from "vitest";
import type { FetchLike, PointCloudTransport } from "@voxelkloud/core";
import { fetchHead, fetchRange } from "./range.js";

const URL_T = "https://example.test/tile.copc.laz";

/** Um arquivo de `size` bytes, com o valor de cada byte a ser o seu índice. */
const file = (size: number): Uint8Array =>
  Uint8Array.from({ length: size }, (_, i) => i % 251);

/** O corpo de uma Response. `BodyInit` do lib.dom não conhece esta variante. */
const body = (b: Uint8Array): BodyInit => b as unknown as BodyInit;

/**
 * Um servidor que honra `Range` como a RFC 9110 manda: um intervalo que passa
 * do fim é satisfeito com o que existe, e o `Content-Range` diz onde acabou.
 */
function correct(bytes: Uint8Array): PointCloudTransport {
  return {
    requestInit: undefined,
    fetch: async (_url, init) => {
      const range = new Headers(init?.headers).get("Range");
      if (range === null) return new Response(body(bytes), { status: 200 });
      const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const from = Number(m[1]);
      if (from >= bytes.byteLength) return new Response(null, { status: 416 });
      const to = Math.min(Number(m[2]), bytes.byteLength - 1);
      return new Response(body(bytes.subarray(from, to + 1)), {
        status: 206,
        headers: { "content-range": `bytes ${from}-${to}/${bytes.byteLength}` },
      });
    },
  };
}

/** Um servidor que devolve menos do que tem, e diz que ainda há mais. */
function truncating(bytes: Uint8Array, serve: number): PointCloudTransport {
  return {
    requestInit: undefined,
    fetch: async (_url, init) => {
      const range = new Headers(init?.headers).get("Range");
      const m = /^bytes=(\d+)-(\d+)$/.exec(range!)!;
      const from = Number(m[1]);
      const to = Number(m[2]);
      return new Response(body(bytes.subarray(from, from + serve)), {
        status: 206,
        // Anuncia o intervalo INTEIRO que foi pedido, e entrega menos.
        headers: { "content-range": `bytes ${from}-${to}/${bytes.byteLength}` },
      });
    },
  };
}

/** Um servidor que responde 206 curto e não diz onde o arquivo acaba. */
function mute(bytes: Uint8Array): PointCloudTransport {
  return {
    fetch: (async () => new Response(body(bytes), { status: 206 })) as FetchLike,
    requestInit: undefined,
  };
}

/** Um servidor que ignora `Range` por completo. */
function ignoresRange(bytes: Uint8Array): PointCloudTransport {
  return {
    fetch: (async () => new Response(body(bytes), { status: 200 })) as FetchLike,
    requestInit: undefined,
  };
}

describe("fetchHead — o ladrilho menor que a sondagem", () => {
  it("devolve o arquivo inteiro quando ele é menor que o pedido", async () => {
    // 1410 bytes é o tamanho real de um dos blocos TLS de Garopaba que
    // derrubava o projeto todo.
    const bytes = file(1410);
    const got = await fetchHead(correct(bytes), URL_T, 8192, undefined);
    expect(got.byteLength).toBe(1410);
    expect([...got.subarray(0, 4)]).toEqual([...bytes.subarray(0, 4)]);
  });

  it("devolve exatamente o pedido quando o arquivo é maior", async () => {
    const got = await fetchHead(correct(file(50_000)), URL_T, 8192, undefined);
    expect(got.byteLength).toBe(8192);
  });

  it("aceita também o host que ignora Range e manda o arquivo pequeno inteiro", async () => {
    const got = await fetchHead(ignoresRange(file(1410)), URL_T, 8192, undefined);
    expect(got.byteLength).toBe(1410);
  });
});

describe("fetchHead — o que continua a ser erro", () => {
  it("recusa um host que entrega menos e diz que há mais", async () => {
    // O CASO QUE NÃO PODE PASSAR. Sem esta distinção, afrouxar o 206 curto
    // teria trocado um erro claro por um cabeçalho truncado a chegar ao
    // decodificador.
    await expect(
      fetchHead(truncating(file(50_000), 3000), URL_T, 8192, undefined),
    ).rejects.toThrow(/Range support is broken/);
  });

  it("recusa quando a origem não diz onde o arquivo acaba", async () => {
    // Sem `Content-Range` não há como separar "acabou" de "truncou", e adivinhar
    // a favor do host seria adivinhar a favor do caso que corrompe.
    await expect(
      fetchHead(mute(file(1410)), URL_T, 8192, undefined),
    ).rejects.toThrow(/Range support is broken/);
  });
});

describe("fetchRange — o intervalo exato continua exato", () => {
  it("lê um intervalo no meio do arquivo", async () => {
    const got = await fetchRange(correct(file(50_000)), URL_T, 1000, 256, undefined);
    expect(got.byteLength).toBe(256);
    expect(got[0]).toBe(1000 % 251);
  });

  it("RECUSA uma leitura curta, mesmo quando o arquivo genuinamente acabou", async () => {
    // A diferença que justifica as duas funções existirem. Aqui o intervalo veio
    // dos offsets do PRÓPRIO arquivo — é o COPC a dizer onde os pontos de um nó
    // vivem — e receber menos significa que o arquivo está truncado em relação
    // ao que promete. Devolver o pedaço curto entregaria um nó incompleto ao
    // decodificador sem ninguém saber.
    await expect(
      fetchRange(correct(file(1410)), URL_T, 1000, 8192, undefined),
    ).rejects.toThrow(/Range support is broken/);
  });
});
