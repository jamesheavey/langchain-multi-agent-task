import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { makeSupervisor } from './agents/supervisor';
import { makeCatFactAgent } from './agents/catFacts';
import { MemorySaver } from '@langchain/langgraph';
import { makeMarketingAdvisorAgent } from './agents/marketingAdvisor';
import type { RunnableConfig } from '@langchain/core/runnables';
import chalk from 'chalk';
import { createToolNode } from './utils/createToolNode';
import { delegateTool } from './tools/delegate';
import { makeMathsExpert } from './agents/mathsExpert';
import { createAgent } from './agents/shared';
import { makeSearcherAgent } from './agents/searcher';

const checkpointer = new MemorySaver();

export type GraphState = {
	messages: BaseMessage[];
	nextAgent: string;
};

const OverallGraphState = Annotation.Root({
	messages: Annotation<BaseMessage[]>({
		reducer: (x, y) => x.concat(y),
		default: () => []
	}),
	nextAgent: Annotation<string>({
		reducer: (x?: string, y?: string) => y ?? '',
		default: () => ''
	})
});

// Wrap the agent to return the last message
function wrapAgent(params: ReturnType<typeof createAgent>) {
	return async (state: GraphState, config?: RunnableConfig) => {
		console.log(`Invoking agent ${chalk.blue(params.name)}...`);

		const result = await params.agent.invoke(state, config);

		console.log(
			`Agent ${chalk.blue(params.name)} returned message: ${chalk.yellow(result.content)}`
		);

		return {
			messages: [result]
		};
	};
}

// If an agent calls delegate, switch to the delegate node
// Otherwise, stay in the same node
const handleDelegateCondition = (params: { next: string; toolsNodeName?: string }) => {
	return (state: GraphState) => {
		const { messages } = state;
		const lastMessage = messages.at(-1) as AIMessage;

		const toolCalls = lastMessage.tool_calls;

		// We do not allow parallel tool calls, so we can assume that there is only one tool call
		// If the agent called delegate, switch nodes
		const toolCall = toolCalls?.at(0);

		if (toolCall?.name === delegateTool.name) {
            console.log(chalk.gray('Agent called delegate, switching to delegate node'));
			return 'delegate';
		}

		if (params.toolsNodeName !== undefined && toolCall !== undefined) {
            console.log(chalk.gray(`Going to tools node: ${params.toolsNodeName}`));
			return params.toolsNodeName;
		}

        console.log(chalk.gray(`Next agent is ${params.next}`));
		return params.next;
	};
};

export const makeChatbotGraph = async () => {
	const agentsAndTools = {
		supervisor: makeSupervisor(),
		mathsExpert: makeMathsExpert(),
		catFacts: makeCatFactAgent(),
		marketingAdvisor: makeMarketingAdvisorAgent(),
        searcher: makeSearcherAgent()
	};

	// Add agents to the graph
	// (Would loop this but typescript doesn't like it)
	const workflow = new StateGraph(OverallGraphState)
		.addNode('supervisor', wrapAgent(agentsAndTools['supervisor']))
		.addNode('mathsExpert', wrapAgent(agentsAndTools['mathsExpert']))
		.addNode('catFacts', wrapAgent(agentsAndTools['catFacts']))
		.addNode('marketingAdvisor', wrapAgent(agentsAndTools['marketingAdvisor']))
		.addNode('searcher', wrapAgent(agentsAndTools['searcher']));

	// Add tool node for delegation
	workflow.addNode('delegate', createToolNode([delegateTool])).addConditionalEdges(
		'delegate',
		(state: GraphState) => {
			const { messages } = state;
			const lastMessage = messages.at(-1) as ToolMessage;
			const route = (lastMessage.content as string).split('\n')[0];

            console.log(`${chalk.gray("Delegating to:")} ${chalk.greenBright(route)}`);

			return route;
		},
		{
			supervisor: 'supervisor',
			catFacts: 'catFacts',
			marketingAdvisor: 'marketingAdvisor',
			mathsExpert: 'mathsExpert',
            searcher: 'searcher'
		}
	);

	// Let the supervisor delegate to the sub agents OR end the conversation
	workflow.addConditionalEdges(
		'supervisor',
		handleDelegateCondition({
			next: END
		}),
		{
			delegate: 'delegate',
			__end__: END
		} as any
	);

	// Let sub agents delegate to eachother
	Object.keys(agentsAndTools)
		.filter((agentKey) => agentKey !== 'supervisor')
		.forEach((agent) => {
			const agentName = agent as keyof typeof agentsAndTools;

			let edges = {
				delegate: 'delegate',
				supervisor: 'supervisor'
			} as any;

			if (agentsAndTools[agentName].toolsNode !== undefined) {
				// Add agent tools to the graph
				workflow.addNode(`${agentName}Tools`, agentsAndTools[agentName].toolsNode!);
				workflow.addEdge(`${agentName}Tools` as any, agentName);

				// Include in conditional edge
				edges[`${agentName}Tools`] = `${agentName}Tools`;
			}

			workflow.addConditionalEdges(
				agentName,
				handleDelegateCondition({
					next: 'supervisor',
					toolsNodeName:
						agentsAndTools[agentName].toolsNode !== undefined ? `${agentName}Tools` : undefined
				}),
				edges
			);
		});

	// Start at the supervisor agent
	workflow.addEdge(START, 'supervisor');

	return workflow.compile({
		checkpointer
	});
};
