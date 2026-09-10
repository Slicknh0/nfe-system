/**
 * Tradução de erro de parser para linguagem funcional.
 *
 * O validador libxml devolve mensagens como:
 *
 *   Element '{http://www.portalfiscal.inf.br/nfe}infNFe', attribute 'Id':
 *   [facet 'pattern'] The value 'NFe123' is not accepted by the pattern '...'
 *
 * Isso é acionável para quem escreveu o XML e inútil para quem está emitindo a
 * nota. A mensagem técnica continua íntegra e vai para o log; a explicação
 * funcional é o que a UI mostra.
 *
 * Regra que não pode ser violada: a tradução nunca inventa causa fiscal. Quando
 * o padrão não é reconhecido, devolve-se a mensagem técnica com um rótulo
 * genérico honesto, em vez de um palpite que mandaria o usuário para o campo
 * errado.
 */

export interface TranslatedSchemaError {
  /** Mensagem original do parser. Vai para o log, nunca é descartada. */
  readonly technicalMessage: string;
  /** Caminho/elemento provavelmente envolvido, quando extraível. */
  readonly element?: string;
  /** Atributo envolvido, quando extraível. */
  readonly attribute?: string;
  /** Explicação em linguagem de negócio. */
  readonly explanation: string;
  /** Ação sugerida ao usuário. */
  readonly suggestedAction: string;
  /** `true` quando a explicação veio de regra reconhecida; `false` no fallback. */
  readonly recognized: boolean;
}

const NAMESPACE_PREFIX = /\{[^}]*\}/g;

function stripNamespace(value: string): string {
  return value.replace(NAMESPACE_PREFIX, '');
}

interface ExtractedContext {
  readonly element?: string;
  readonly attribute?: string;
}

function extractContext(message: string): ExtractedContext {
  const elementMatch = /Element '([^']+)'/.exec(message);
  const attributeMatch = /attribute '([^']+)'/.exec(message);

  const context: { element?: string; attribute?: string } = {};
  if (elementMatch?.[1] !== undefined) {
    context.element = stripNamespace(elementMatch[1]);
  }
  if (attributeMatch?.[1] !== undefined) {
    context.attribute = attributeMatch[1];
  }
  return context;
}

interface Rule {
  readonly test: RegExp;
  readonly build: (message: string, context: ExtractedContext) => {
    explanation: string;
    suggestedAction: string;
  };
}

function fieldLabel(context: ExtractedContext): string {
  if (context.attribute !== undefined && context.element !== undefined) {
    return `${context.element}/@${context.attribute}`;
  }
  return context.element ?? 'campo do documento';
}

const RULES: readonly Rule[] = [
  {
    test: /\[facet 'pattern'\]/,
    build: (_message, context) => ({
      explanation:
        `O campo ${fieldLabel(context)} está preenchido em um formato que o leiaute ` +
        `oficial da NF-e não aceita.`,
      suggestedAction:
        'Revise o valor desse campo no cadastro de origem. Formatos com pontuação, ' +
        'espaços, letras minúsculas ou quantidade de caracteres diferente da exigida ' +
        'são as causas mais comuns.',
    }),
  },
  {
    test: /\[facet '(maxLength|length)'\]/,
    build: (_message, context) => ({
      explanation: `O campo ${fieldLabel(context)} excede o tamanho máximo permitido.`,
      suggestedAction: 'Reduza o conteúdo desse campo ao limite definido pelo leiaute.',
    }),
  },
  {
    test: /\[facet 'minLength'\]/,
    build: (_message, context) => ({
      explanation: `O campo ${fieldLabel(context)} está mais curto que o mínimo exigido.`,
      suggestedAction: 'Complete o valor desse campo no cadastro de origem.',
    }),
  },
  {
    test: /\[facet 'enumeration'\]/,
    build: (_message, context) => ({
      explanation:
        `O campo ${fieldLabel(context)} recebeu um código que não pertence à lista ` +
        `de valores válidos do leiaute.`,
      suggestedAction:
        'Selecione um dos códigos previstos para esse campo. Se o código veio de uma ' +
        'regra fiscal cadastrada, revise essa regra.',
    }),
  },
  {
    test: /This element is not expected|Missing child element/,
    build: (_message, context) => ({
      explanation:
        `A estrutura do documento diverge do leiaute na altura de ${fieldLabel(context)}: ` +
        `há grupo faltando ou fora da ordem exigida.`,
      suggestedAction:
        'Verifique se todos os grupos obrigatórios da operação foram preenchidos. ' +
        'A ordem dos grupos no XML é definida pelo schema e não é livre.',
    }),
  },
  {
    test: /The attribute '[^']+' is required/,
    build: (_message, context) => ({
      explanation: `Um atributo obrigatório não foi informado em ${fieldLabel(context)}.`,
      suggestedAction: 'Complete a informação obrigatória antes de reenviar.',
    }),
  },
];

export function translateSchemaError(technicalMessage: string): TranslatedSchemaError {
  const context = extractContext(technicalMessage);
  const rule = RULES.find((candidate) => candidate.test.test(technicalMessage));

  if (rule === undefined) {
    return {
      technicalMessage,
      ...context,
      explanation:
        'O documento não passou na validação contra o schema oficial da NF-e, ' +
        'em um ponto que o sistema ainda não sabe explicar em linguagem de negócio.',
      suggestedAction:
        'Encaminhe a mensagem técnica ao suporte fiscal. Ela identifica exatamente ' +
        'o ponto do leiaute que foi violado.',
      recognized: false,
    };
  }

  const { explanation, suggestedAction } = rule.build(technicalMessage, context);
  return { technicalMessage, ...context, explanation, suggestedAction, recognized: true };
}
