import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

export async function node(
  nodeId: number, // the ID of the node
  N: number, // total number of nodes in the network
  F: number, // number of faulty nodes in the network
  initialValue: Value, // initial value of the node
  isFaulty: boolean, // true if the node is faulty, false otherwise
  nodesAreReady: () => boolean, // used to know if all nodes are ready to receive requests
  setNodeIsReady: (index: number) => void // this should be called when the node is started and ready to receive requests
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  let killed: boolean = false; // this is used to know if the node was stopped by the /stop route. It's important for the unit tests but not very relevant for the Ben-Or implementation
  let x: 0 | 1 | "?" | null = initialValue; // the current consensus value
  let decided: boolean | null = false; // used to know if the node reached finality
  let k: any = 0; // current step of the node

  let messages: any[] = [];

  // this route allows retrieving the current status of the node
  node.get("/status", (req, res) => {
    if (isFaulty)      
      res.status(500).send("faulty")
    else
      res.status(200).send("live")})

  // this route allows the node to receive messages from other nodes
  node.post("/message", (req, res) => {
    const message = req.body;
    if (message.decision && !isFaulty) {
      // if a decision has been broadcast by any node, adopt it immediately
      decided = true;
      x = message.value;
    }
    messages.push(message);
    res.send("received");
  });

  // this route is used to start the consensus algorithm
  node.get("/start", async (req, res) => {
    if (isFaulty) {
      x = null
      decided = null
      k = null
    }

    // wait until all nodes are ready before starting rounds
    while (!nodesAreReady()) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if(!isFaulty)
      while (!killed && !decided) {
        // Broadcast our current value and round number to all other nodes
        const msg = { round: k, value: x, decision: false };
        for (let i = 0; i < N; i++) {
          if (i === nodeId) continue;
          try {
            fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(msg),
            });
          } catch (e) {
            // ignore network errors
          }
        }

        // Wait for a fixed time to allow messages to arrive
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Get all messages from the current round
        const roundMessages = messages.filter((m) => m.round === k);

        // Check if any decision message was received in this round.
        const decisionMsg = roundMessages.find((m) => m.decision);
        if (decisionMsg) {
          decided = true;
          x = decisionMsg.value;
          console.log(await fetch(`http://localhost:${BASE_NODE_PORT + nodeId}/getState`).then((res) => res.json()))
          res.send(`decided ${x}`);
          return;
        }

        // Count occurrences of each value (only counting 0 and 1)
        const count0 = roundMessages.filter((m) => m.value === 0).length + (x === 0 ? 1 : 0);
        const count1 = roundMessages.filter((m) => m.value === 1).length + (x === 1 ? 1 : 0);

        // If one of the values appears in half the nodes, decide on it.
        if (count0 > N / 2) {
          decided = true;
          x = 0;
        } else if (count1 > N / 2) {
          decided = true;
          x = 1;
        }

        if (decided) {
          // Broadcast our decision to all nodes.
          const decisionBroadcast = { round: k, value: x, decision: true };
          for (let i = 0; i < N; i++) {
            if (i === nodeId) continue;
            try {
              fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(decisionBroadcast),
              });
            } catch (e) {
              // ignore errors
            }
          }
          console.log(await fetch(`http://localhost:${BASE_NODE_PORT + nodeId}/getState`).then((res) => res.json()))
          res.send(`decided ${x}`);
          return;
        }


        // If no decision was made, update x based on the messages:
        // If one of the values appears in at least (N - F) messages, adopt that value.
        if (count0 >= N - F) {
          x = 0;
        } else if (count1 >= N - F) {
          x = 1;
        } else {
          // Otherwise, use a coin toss to set x
          x = Math.random() < 0.5 ? 0 : 1;
        }
        
        console.log(await fetch(`http://localhost:${BASE_NODE_PORT + nodeId}/getState`).then((res) => res.json()))
        k++; // move to the next round
      }

    res.send("stopped");
  });

  // this route is used to stop the consensus algorithm
  node.get("/stop", async (req, res) => {
    killed = true
    res.send("success")
  });

  // get the current state of a node
  node.get("/getState", (req, res) => {
    res.json({ "killed": killed, "x": x, "decided": decided, "k": k});
  });

  // start the server
  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(
      `Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`
    );

    // the node is ready
    setNodeIsReady(nodeId);
  });

  return server;
}
