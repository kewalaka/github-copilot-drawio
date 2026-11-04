import { applyOperations, type Operation } from './model';

const box = (id: string, label: string, parent: string, x: number, y: number, width: number, height: number, network = false): Operation => ({
  kind: 'add', id, label, parent, geometry: { x, y, width, height },
  style: `swimlane;html=0;startSize=36;horizontal=1;rounded=0;fillColor=${network ? '#eff6ff' : '#ffffff'};strokeColor=${network ? '#0078d4' : '#64748b'};fontSize=15;fontStyle=1;${network ? 'dashed=1;' : ''}`,
});
const resource = (id: string, label: string, parent: string, x: number, y: number, icon: string): Operation => ({
  kind: 'add', id, label, parent, geometry: { x, y, width: 66, height: 66 },
  style: `shape=image;image=img/lib/azure2/${icon}.svg;verticalLabelPosition=bottom;verticalAlign=top;align=center;fontSize=13;html=0;`,
});
const edge = (id: string, label: string, source: string, target: string, relation: Operation['relation']): Operation => ({ kind: 'add', id, label, source, target, relation });

export function seed() {
  return applyOperations('<mxfile><diagram id="architecture" name="Resource organisation"><mxGraphModel grid="1" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>', [
    box('subscription', 'Azure subscription · integration-dev', '1', 320, 40, 910, 760),
    box('rg-core', 'Resource group · rg-integration-core', 'subscription', 30, 60, 850, 145),
    resource('vault', 'Key Vault', 'rg-core', 370, 52, 'security/Key_Vaults'),
    box('rg-app', 'Resource group · rg-integration-app', 'subscription', 30, 230, 850, 500),
    resource('function', 'Ingestion Function App', 'rg-app', 90, 82, 'compute/Function_Apps'),
    resource('storage', 'Data lake storage', 'rg-app', 380, 82, 'storage/Storage_Accounts'),
    box('vnet', 'Network placement · vnet-integration', 'rg-app', 60, 250, 720, 220, true),
    box('subnet', 'Subnet · private-endpoints', 'vnet', 30, 50, 660, 150, true),
    resource('storage-pe', 'Storage private endpoint', 'subnet', 295, 48, 'networking/Private_Endpoint'),
    { kind: 'add', id: 'aws', label: 'AWS account\nEvent producer\nIntegration boundary only', geometry: { x: 35, y: 440, width: 205, height: 130 }, style: 'rounded=1;whiteSpace=wrap;html=0;fillColor=#fff7ed;strokeColor=#9a3412;fontSize=14;' },
    edge('pe-association', 'private endpoint association', 'storage-pe', 'storage', 'relationship'),
    edge('private-path', 'private network path · VPN assumed', 'aws', 'storage-pe', 'network'),
    edge('ingest-data', 'write ingested events', 'function', 'storage', 'data'),
    edge('secrets', 'retrieve secrets', 'function', 'vault', 'data'),
    { kind: 'add', id: 'legend', label: 'Illustrative design, not discovered infrastructure\nSolid blue: network connectivity · dashed grey: resource relationship · green: data/application flow\nNested network boxes show placement, not ownership. PE ownership: rg-integration-app.\nFunction networking, private DNS and VPN termination intentionally not expanded.', geometry: { x: 320, y: 840, width: 910, height: 95 }, style: 'text;html=0;whiteSpace=wrap;align=left;fontSize=12;fontColor=#475569;' },
  ]);
}
