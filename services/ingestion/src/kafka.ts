import { Kafka, type Producer } from "kafkajs";

const kafka = new Kafka({
  clientId: "ingestion",
  brokers: (process.env.KAFKA_BROKERS ?? "localhost:19092").split(","),
});

let producer: Producer | null = null;

export async function getProducer(): Promise<Producer> {
  if (!producer) {
    producer = kafka.producer();
    await producer.connect();
  }
  return producer;
}
