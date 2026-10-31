// Local-only payment boundary. No PayPal SDK, network request, account or real money.
const { randomUUID } = require('node:crypto');
const { DomainError } = require('./domain');
function createOrder({ projectId, cycleId, draftId, amountCents, lines }) {
  return { id:`SIM-${randomUUID().slice(0,8).toUpperCase()}`, projectId, cycleId, draftId, amountCents, lines:JSON.parse(JSON.stringify(lines)), mode:'SIMULATED', status:'created', createdAt:new Date().toISOString() };
}
function approve(order) { if(order.status!=='created')throw new DomainError('Simulated order cannot be approved in its current state.',409);order.status='approved';order.approvedAt=new Date().toISOString();return order; }
function capture(order) { if(order.status!=='approved')throw new DomainError('Simulated order requires buyer approval.',409);order.status='captured';order.capturedAt=new Date().toISOString();return order; }
function fail(order) { if(!['created','approved'].includes(order.status))throw new DomainError('Simulated order cannot fail in its current state.',409);order.status='failed';order.failedAt=new Date().toISOString();return order; }
function getStatus(order){return order.status;}
module.exports={createOrder,approve,capture,fail,getStatus};
